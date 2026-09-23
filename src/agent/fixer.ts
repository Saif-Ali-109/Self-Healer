// The AI fix stage: worktree → agent loop → full-suite gate → commit → push
// to ci-fix/<run-id> (never force, never a protected branch) → CI comment.
// Returns a result; the orchestrator owns status transitions + escalations.

import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { statSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Pool } from "../db/pool.ts";
import type { LlmClient } from "../llm/types.ts";
import {
	addNote,
	formatNotesForPrompt,
	type NoteInput,
	retrieveNotes,
} from "../memory/notes.ts";
import { postFixComment } from "../pipeline/comments.ts";
import { openFixPr } from "../pipeline/fixscope/fixpr.ts";
import { recordFixAttempt } from "../pipeline/fixscope/record.ts";
import {
	cleanupWorktree,
	setupWorktree,
	type WorktreeHandle,
} from "../pipeline/worktree.ts";
import { chainAgentEvent } from "../sor/ciEvents.ts";
import type { AgentLimits, RepoSettings } from "../settings.ts";
import type {
	CiEvent,
	ClassificationResult,
	EscalationReason,
} from "../types.ts";
import {
	AGENT_VERSION,
	FIX_CONFIDENCE_THRESHOLD,
	isCriticalBranch,
} from "../types.ts";
import type { PipelineBudget } from "../utils/budget.ts";
import { type FinishArgs, runAgentLoop, type TraceFn } from "./loop.ts";
import {
	buildTaskPrompt,
	extractLogExcerpt,
	type PreviousAttempt,
	SYSTEM_PROMPT,
} from "./prompt.ts";
import { runProcess, scrubbedEnv, tailText } from "./sandbox.ts";
import {
	checkGuardrails,
	type Commands,
	detectCommands,
	type DiffInfo,
	diffWarnings,
	type GuardrailViolation,
	runGate,
	type GateResult,
} from "./verify.ts";

const exec = promisify(execFile);

export interface AgentFixArgs {
	pool: Pool;
	runId: string;
	event: CiEvent;
	classification: ClassificationResult;
	logText: string;
	budget: PipelineBudget;
	llm: LlmClient;
	temperature?: number | undefined;
	limits: AgentLimits;
	repoCfg: RepoSettings;
	branch: string; // ci-fix/<id>; reused across re-fix cycles
	cycle: number;
	parentRunId?: string | undefined;
	runsRoot: string;
	cacheDir: string;
	/** Test seams. */
	repoUrl?: string;
	skipComment?: boolean;
}

export type AgentFixResult =
	| {
			kind: "delivered";
			branch: string;
			commitSha: string;
			rootCause: string;
			summary: string;
			filesChanged: string[];
			verification: string;
			warnings: string[];
			commentUrl: string | null;
			/** Fix-only PR URL (best-effort; null when none could be opened). */
			fixPrUrl: string | null;
	  }
	| { kind: "escalate"; reason: EscalationReason; summary: string };

async function git(
	args: string[],
	cwd: string,
	opts: { hooks?: boolean } = {},
): Promise<string> {
	const { stdout } = await exec(
		"git",
		opts.hooks ? args : ["-c", "core.hooksPath=/dev/null", ...args],
		{
			cwd,
			maxBuffer: 64 * 1024 * 1024,
		},
	);
	return stdout;
}

async function collectDiff(
	worktreeDir: string,
): Promise<DiffInfo & { patch: string }> {
	await git(["add", "-A"], worktreeDir);
	const ns = await git(
		["diff", "--cached", "--name-status", "-M"],
		worktreeDir,
	);
	const files = ns
		.split("\n")
		.filter(Boolean)
		.map((l) => {
			const [status = "", ...rest] = l.split("\t");
			return { status, path: rest[rest.length - 1] ?? "" };
		});
	const patch = await git(["diff", "--cached", "-U0", "-M"], worktreeDir);
	const addedLines = patch
		.split("\n")
		.filter((l) => l.startsWith("+") && !l.startsWith("+++"))
		.map((l) => l.slice(1));
	const bigFiles: string[] = [];
	for (const f of files) {
		if (f.status.startsWith("D")) continue;
		try {
			if (statSync(join(worktreeDir, f.path)).size > 1_000_000)
				bigFiles.push(f.path);
		} catch {
			/* ignore */
		}
	}
	return { files, addedLines, bigFiles, patch };
}

async function loadPreviousAttempts(
	pool: Pool,
	parentRunId: string | undefined,
): Promise<PreviousAttempt[]> {
	const out: PreviousAttempt[] = [];
	let cur = parentRunId;
	for (let i = 0; cur && i < 6; i++) {
		const r = await pool.query<{
			parent_run_id: string | null;
			fix_cycle: number;
			root_cause: string | null;
			summary: string | null;
			files_changed: string | null;
		}>(
			`SELECT r.parent_run_id, r.fix_cycle, f.root_cause, f.summary, f.files_changed
			 FROM ci_runs r LEFT JOIN fix_attempts f ON f.run_id = r.run_id WHERE r.run_id = $1`,
			[cur],
		);
		const row = r.rows[0];
		if (!row) break;
		out.push({
			cycle: Number(row.fix_cycle),
			rootCause: row.root_cause ?? "(unknown)",
			summary: row.summary ?? "(no summary recorded)",
			filesChanged: (row.files_changed ?? "").split("\n").filter(Boolean),
		});
		cur = row.parent_run_id ?? undefined;
	}
	return out.reverse();
}

async function storeNotes(
	pool: Pool,
	repo: string,
	runId: string,
	notes: NoteInput[],
	fallback?: NoteInput,
): Promise<void> {
	const list = notes.length > 0 ? notes : fallback ? [fallback] : [];
	const written: Array<{ id: string; merged: boolean; kind: string }> = [];
	for (const n of list) {
		const r = await addNote(
			pool,
			{ repo, runId, source: notes.length > 0 ? "agent" : "system" },
			n,
		);
		if (r) written.push({ ...r, kind: n.kind });
	}
	if (written.length > 0)
		await chainAgentEvent(pool, runId, "ci_notes_written", {
			repo,
			notes: written,
		});
}

export async function attemptAgentFix(
	a: AgentFixArgs,
): Promise<AgentFixResult> {
	const { pool, runId, event, branch } = a;
	const runDir = join(a.runsRoot, runId);
	const trace: TraceFn = (kind, payload, tool) =>
		chainAgentEvent(pool, runId, kind, payload, tool);
	let worktree: WorktreeHandle | undefined;

	try {
		// ── worktree on the FAILING commit ───────────────────────────
		await mkdir(runDir, { recursive: true });
		try {
			worktree = await setupWorktree(
				a.repoUrl ?? `https://github.com/${event.repo}.git`,
				runDir,
				branch,
				undefined,
				event.commit,
			);
		} catch (err) {
			return {
				kind: "escalate",
				reason: "checkout_failed",
				summary: `Could not set up worktree: ${String(err)}`,
			};
		}
		const wt = worktree.worktreeDir;

		// ── how will we verify? (no test command → no fix, ever) ─────
		const cmds: Commands = detectCommands(wt, a.repoCfg);
		if (!cmds.test) {
			return {
				kind: "escalate",
				reason: "no_test_command",
				summary:
					"No test command configured or detected; refusing to push an unverified fix.",
			};
		}
		const env = scrubbedEnv({ runDir, cacheDir: a.cacheDir });
		const toolEnv = { root: wt, env, limits: a.limits };

		// ── local setup (install deps) ───────────────────────────────
		let setupNote = "";
		if (cmds.install) {
			const r = await runProcess(cmds.install, {
				cwd: wt,
				env,
				timeoutMs: a.limits.gateTimeoutMs,
				wrapper: a.limits.commandWrapper,
			});
			if (r.code !== 0) {
				setupNote = `\n\nNOTE: dependency install (${cmds.install.join(" ")}) FAILED locally — this may be the CI failure itself:\n${tailText(r.output, 3000)}`;
			}
		}

		// ── notes in, task out ───────────────────────────────────────
		const excerpt = extractLogExcerpt(a.logText);
		const notes = await retrieveNotes(
			a.pool,
			event.repo,
			`${event.job_name ?? ""}\n${excerpt.text}`,
		);
		const previousAttempts =
			a.cycle > 0 ? await loadPreviousAttempts(pool, a.parentRunId) : [];
		await chainAgentEvent(pool, runId, "ci_agent_start", {
			agent_version: AGENT_VERSION,
			provider: a.llm.provider,
			model: a.llm.model,
			cycle: a.cycle,
			max_cycles: a.limits.maxFixCycles,
			branch,
			test_command: cmds.test.join(" "),
			commands_source: cmds.source,
			budget: {
				max_llm_calls: a.limits.maxLlmCalls,
				max_tool_calls: a.limits.maxToolCalls,
				time_ms: a.budget.remainingMs(),
			},
		});
		if (notes.length > 0) {
			await chainAgentEvent(pool, runId, "ci_notes_read", {
				notes: notes.map((n) => ({
					id: n.note_id,
					kind: n.kind,
					body: n.body,
					confidence: n.confidence,
				})),
			});
		}
		const task =
			buildTaskPrompt({
				repo: event.repo,
				branch: event.branch,
				commit: event.commit,
				jobName: event.job_name,
				cycle: a.cycle,
				maxCycles: a.limits.maxFixCycles,
				classification: {
					category: a.classification.category,
					confidence: a.classification.confidence,
					evidence: a.classification.evidence.map((e) => e.signal),
				},
				testCommand: cmds.test.join(" "),
				extraChecks: cmds.extraChecks.map((c) => c.join(" ")),
				notesBlock: formatNotesForPrompt(notes),
				previousAttempts,
				logExcerpt: excerpt.text,
				logTruncated: excerpt.truncated,
			}) + setupNote;

		// ── the loop ─────────────────────────────────────────────────
		let lowConfidence = false;
		let lastViolation: GuardrailViolation | null = null;
		let lastGate: GateResult | null = null;
		let accepted: {
			diff: Awaited<ReturnType<typeof collectDiff>>;
			gate: GateResult;
		} | null = null;

		const onFinish = async (
			f: FinishArgs,
		): Promise<{ accepted: boolean; feedback: string }> => {
			if (f.confidence < FIX_CONFIDENCE_THRESHOLD) {
				lowConfidence = true;
				return {
					accepted: true,
					feedback: `self-reported confidence ${f.confidence} is below ${FIX_CONFIDENCE_THRESHOLD}; not pushing`,
				};
			}
			const diff = await collectDiff(wt);
			const violation = checkGuardrails(diff, a.limits.maxFilesChanged);
			if (violation) {
				lastViolation = violation;
				lastGate = null;
				return { accepted: false, feedback: violation.message };
			}
			lastViolation = null;
			// Re-install only when a dependency manifest changed.
			if (
				cmds.install &&
				diffWarnings(diff).some((w) => w.startsWith("Dependency"))
			) {
				const r = await runProcess(cmds.install, {
					cwd: wt,
					env,
					timeoutMs: a.limits.gateTimeoutMs,
					wrapper: a.limits.commandWrapper,
				});
				if (r.code !== 0) {
					lastGate = {
						passed: false,
						summary: `${cmds.install.join(" ")}: exit ${r.code}`,
						failureOutput: tailText(r.output, 6000),
						ranCommands: [cmds.install.join(" ")],
					};
					await chainAgentEvent(pool, runId, "ci_agent_gate", {
						passed: false,
						summary: lastGate.summary,
					});
					return {
						accepted: false,
						feedback: `dependency install failed after your change:\n${lastGate.failureOutput}`,
					};
				}
			}
			const gate = await runGate(cmds, {
				cwd: wt,
				env,
				timeoutMs: a.limits.gateTimeoutMs,
				wrapper: a.limits.commandWrapper,
			});
			lastGate = gate;
			await chainAgentEvent(
				pool,
				runId,
				"ci_agent_gate",
				{
					passed: gate.passed,
					summary: gate.summary,
					files: diff.files.map((x) => `${x.status} ${x.path}`),
				},
				{
					name: "full_suite",
					input: gate.ranCommands,
					output: gate.passed ? "passed" : gate.failureOutput,
				},
			);
			if (!gate.passed)
				return {
					accepted: false,
					feedback: `FULL SUITE FAILED — ${gate.summary}\n${gate.failureOutput}`,
				};
			accepted = { diff, gate };
			return { accepted: true, feedback: gate.summary };
		};

		const outcome = await runAgentLoop({
			llm: a.llm,
			system: SYSTEM_PROMPT,
			task,
			toolEnv,
			limits: a.limits,
			budget: a.budget,
			temperature: a.temperature,
			onFinish,
			trace,
		});

		// ── interpret the outcome ────────────────────────────────────
		const jobTag = (event.job_name ?? "").toLowerCase();
		switch (outcome.status) {
			case "gave_up": {
				const g = outcome.give_up;
				await storeNotes(pool, event.repo, runId, g.notes, {
					kind: "run_outcome",
					text: `Agent could not fix job "${event.job_name ?? "?"}": ${g.reason}`.slice(
						0,
						280,
					),
					tags: [jobTag],
				});
				return {
					kind: "escalate",
					reason: "agent_gave_up",
					summary: `${g.reason}\n\nAgent rationale: ${g.rationale}`.slice(
						0,
						3000,
					),
				};
			}
			case "budget":
				await storeNotes(pool, event.repo, runId, outcome.notes);
				return {
					kind: "escalate",
					reason: "budget_exhausted",
					summary: `Agent ran out of budget: ${outcome.detail}.`,
				};
			case "llm_error":
				return {
					kind: "escalate",
					reason: "llm_unavailable",
					summary: `LLM provider ${a.llm.provider}/${a.llm.model} failed: ${outcome.detail}`,
				};
			case "rejected": {
				await recordFixAttempt(pool, {
					runId,
					patternMatched: "ai-agent",
					diff: (
						await collectDiff(wt).catch(() => ({ patch: "" }))
					).patch.slice(0, 50_000),
					branch,
					verificationResult: "failed",
					testSummary:
						(lastGate as GateResult | null)?.summary ??
						(lastViolation as GuardrailViolation | null)?.message ??
						outcome.detail,
					model: `${a.llm.provider}/${a.llm.model}`,
				});
				await storeNotes(pool, event.repo, runId, outcome.notes, {
					kind: "run_outcome",
					text: `Agent's proposed fix for job "${event.job_name ?? "?"}" was refused: ${outcome.detail.split("\n")[0] ?? ""}`.slice(
						0,
						280,
					),
					tags: [jobTag],
				});
				const v = lastViolation as GuardrailViolation | null;
				if (v?.kind === "multi_file")
					return { kind: "escalate", reason: "multi_file", summary: v.message };
				if (v)
					return {
						kind: "escalate",
						reason: "guardrail_violation",
						summary: v.message,
					};
				return {
					kind: "escalate",
					reason: "fix_failed",
					summary:
						`Fix did not pass the full suite after repeated attempts: ${outcome.detail}`.slice(
							0,
							3000,
						),
				};
			}
			case "finished":
				break;
		}

		const fin = outcome.finish;
		if (lowConfidence) {
			await storeNotes(pool, event.repo, runId, fin.notes);
			return {
				kind: "escalate",
				reason: "low_confidence",
				summary: `Agent's diagnosis: ${fin.root_cause}\nConfidence ${fin.confidence} is below ${FIX_CONFIDENCE_THRESHOLD}; not pushing.`,
			};
		}
		const acc = accepted as {
			diff: Awaited<ReturnType<typeof collectDiff>>;
			gate: GateResult;
		} | null;
		if (!acc)
			return {
				kind: "escalate",
				reason: "fix_failed",
				summary: "internal: finish accepted without a passing gate",
			};

		// ── push (only ci-fix/*, never force, never protected) ───────
		if (!branch.startsWith("ci-fix/") || isCriticalBranch(branch)) {
			return {
				kind: "escalate",
				reason: "critical_branch",
				summary: `Refusing to push to non-agent branch '${branch}'.`,
			};
		}
		const filesChanged = acc.diff.files.map((f) => f.path);
		const warnings = diffWarnings(acc.diff);
		const name = process.env.SELF_HEALER_GIT_NAME || "Self-Healer";
		const email =
			process.env.SELF_HEALER_GIT_EMAIL ||
			"self-healer@users.noreply.github.com";
		const title =
			fin.summary.split("\n")[0]?.slice(0, 68) ?? "automated CI fix";
		const message = `fix(ci): ${title}\n\nRoot cause: ${fin.root_cause}\n\nAutomated by Self-Healer (run ${runId}, cycle ${a.cycle}, ${a.llm.provider}/${a.llm.model}).`;
		let commitSha = "";
		try {
			await git(
				[
					"-c",
					`user.name=${name}`,
					"-c",
					`user.email=${email}`,
					"commit",
					"-m",
					message,
				],
				wt,
			);
			commitSha = (await git(["rev-parse", "HEAD"], wt)).trim();
			await git(["push", "origin", `HEAD:refs/heads/${branch}`], wt);
		} catch (err) {
			return {
				kind: "escalate",
				reason: "checkout_failed",
				summary: `Fix verified locally but commit/push failed: ${String(err instanceof Error ? err.message : err).slice(0, 500)}`,
			};
		}

		await recordFixAttempt(pool, {
			runId,
			patternMatched: "ai-agent",
			diff: acc.diff.patch.slice(0, 50_000),
			branch,
			verificationResult: "passed",
			testSummary: acc.gate.summary,
			rootCause: fin.root_cause,
			summary: fin.summary,
			filesChanged,
			model: `${a.llm.provider}/${a.llm.model}`,
		});
		await pool.query("UPDATE ci_runs SET fix_branch = $1 WHERE run_id = $2", [
			branch,
			runId,
		]);

		// Notes: the agent's own, or (so memory always grows) the diagnosis itself.
		await storeNotes(pool, event.repo, runId, fin.notes, {
			kind: "root_cause",
			text: `${fin.root_cause} Fix: ${fin.summary}`.slice(0, 290),
			tags: [jobTag],
			files: filesChanged,
		});

		// Fix-only PR (best-effort, does not run when the agent was told to
		// skip outbound calls): opens ci-fix/<run-id> → failing branch for
		// human review. Any failure falls back to branch + comment.
		let fixPrUrl: string | null = null;
		if (!a.skipComment) {
			try {
				fixPrUrl = await openFixPr(pool, {
					runId,
					repo: event.repo,
					externalRunId: event.external_run_id,
					headBranch: branch,
					baseBranch: event.branch,
					rootCause: fin.root_cause,
					summary: fin.summary,
					reasoning: fin.rationale,
					model: `${a.llm.provider}/${a.llm.model}`,
					cycle: a.cycle,
					maxCycles: a.limits.maxFixCycles,
					warnings,
					diffSummary: `${filesChanged.length} file(s): ${filesChanged.join(", ")}`,
					verification: acc.gate.summary,
				});
			} catch (err) {
				console.warn("[fixer] fix PR open failed (non-fatal):", err);
				fixPrUrl = null;
			}
		}

		const commentUrl = a.skipComment
			? null
			: await postFixComment(event.repo, event.external_run_id, {
					rootCause: fin.root_cause,
					pattern: "ai-agent",
					branch,
					diffSummary: `${filesChanged.length} file(s): ${filesChanged.join(", ")}`,
					verification: acc.gate.summary,
					summary: fin.summary,
					reasoning: fin.rationale,
					cycle: a.cycle,
					maxCycles: a.limits.maxFixCycles,
					warnings,
					model: `${a.llm.provider}/${a.llm.model}`,
					fixPrUrl: fixPrUrl ?? undefined,
				});
		if (commentUrl)
			await pool.query(
				"UPDATE fix_attempts SET comment_url = $1 WHERE run_id = $2",
				[commentUrl, runId],
			);

		return {
			kind: "delivered",
			branch,
			commitSha,
			rootCause: fin.root_cause,
			summary: fin.summary,
			filesChanged,
			verification: acc.gate.summary,
			warnings,
			commentUrl,
			fixPrUrl,
		};
	} finally {
		if (worktree) await cleanupWorktree(worktree, true).catch(() => {});
		await rm(runDir, { recursive: true, force: true }).catch(() => {});
	}
}
