// Central CI pipeline orchestrator — the integration hub.
// Wires: webhook → queue → worktree → classifier → route (retry / fix / escalate).
// Owns: orchestrator.ts (T024 + T027 + T033 + T037). Single writer — no other
// file modifies this module, satisfying the constitution's no-same-file rule.

import { join } from "node:path";
import { attemptAgentFix } from "../agent/fixer.ts";
import type { Pool } from "../db/pool.ts";
import { getPool } from "../db/pool.ts";
import { createLlmClient, credentialsFromEnv, resolveLlm } from "../llm/resolve.ts";
import { addNote, penalizeRunNotes } from "../memory/notes.ts";
import {
	limitsFor,
	loadSettings,
	parseSettings,
	repoSettings,
	type Settings,
} from "../settings.ts";
import { chainAgentEvent, chainRunTransition } from "../sor/ciEvents.ts";
import type {
	CiEvent,
	ClassificationResult,
	EscalationReason,
} from "../types.ts";
import { isCriticalBranch } from "../types.ts";
import { PipelineBudget } from "../utils/budget.ts";
import { classify, fetchJobLogs } from "./classifier/index.ts";
import { writeEscalation } from "./escalation/writer.ts";
import { fixBranchName } from "./fixscope/record.ts";
import { CiQueue } from "./queue.ts";
import { retryFlaky } from "./retry/runner.ts";

const RUNS_ROOT = join(process.cwd(), ".runs");
const CACHE_DIR = join(process.cwd(), "data", "cache");

export interface PipelineResult {
	runId: string;
	path: "resolved" | "escalated" | "fix_delivered" | "error";
	reason?: string;
}

/**
 * Process a single CI failure event end-to-end.
 *
 * Flow:
 *   pending → classifying → [retrying | fixing | escalated | resolved]
 */
export async function processCiFailure(
	event: CiEvent,
	opts: { runId?: string } = {},
): Promise<PipelineResult> {
	const pool = getPool();
	const queue = new CiQueue(pool);
	let settings: Settings;
	let settingsError: string | undefined;
	try {
		settings = loadSettings();
	} catch (err) {
		settingsError = String(err instanceof Error ? err.message : err);
		console.error(`[orchestrator] ${settingsError} — falling back to defaults`);
		settings = parseSettings({});
	}
	const limits = limitsFor(settings, event.repo);
	const budget = new PipelineBudget(
		new Date(),
		limits.maxLlmCalls,
		limits.pipelineBudgetMs,
	);

	// Intake (webhook path): enqueue + dedupe. The worker path passes an
	// existing runId (row already in ci_runs) and must NOT re-enqueue.
	let runId = opts.runId;
	if (!runId) {
		const enqueueResult = await queue.enqueue(event);
		if (!enqueueResult.ok) {
			return { runId: "", path: "error", reason: "enqueue_failed" };
		}
		if (enqueueResult.duplicate) {
			console.log(
				`[orchestrator] duplicate event ignored: ${event.external_run_id}:${event.repo}:${event.job_id}`,
			);
			return { runId: "", path: "error", reason: "duplicate" };
		}
		runId = enqueueResult.run_id!;
	}
	if (!runId) {
		return { runId: "", path: "error", reason: "enqueue_failed" };
	}

	try {
		// ── Lineage: is this CI failing again on a branch we pushed a fix to? ──
		const lineage = await resolveLineage(pool, event);
		if (lineage.cycle > 0 && lineage.parentRunId) {
			await pool.query(
				"UPDATE ci_runs SET parent_run_id = $1, fix_cycle = $2 WHERE run_id = $3",
				[lineage.parentRunId, lineage.cycle, runId],
			);
			// The previous fix (and the notes it was built on) did not hold.
			await penalizeRunNotes(pool, lineage.parentRunId);
		}

		// ── Stage 1: Classify ────────────────────────────────────────
		await queue.updateStatus(runId, "classifying");
		await chainRunTransition(pool, runId, "pending", "classifying");

		if (budget.isExpired()) {
			return escalate(
				pool,
				runId,
				event,
				"budget_exhausted",
				"Pipeline budget expired during classification stage.",
				budget,
			);
		}

		let classification: ClassificationResult;
		try {
			classification = await classify(pool, runId, event.repo, event.log_url);
		} catch (err) {
			return escalate(
				pool,
				runId,
				event,
				"checkout_failed",
				`Classifier failed: ${String(err)}`,
				budget,
			);
		}

		console.log(
			`[orchestrator] run ${runId} classified as ${classification.category} (confidence ${classification.confidence})`,
		);

		// ── Stage 2: Route ───────────────────────────────────────────
		switch (classification.category) {
			case "flaky":
				return routeFlaky(pool, runId, event, classification, budget);

			case "infra":
				// MVP: infra is stubbed → immediate escalation
				return escalate(
					pool,
					runId,
					event,
					"infra",
					`Infrastructure failure detected. Evidence: ${classification.evidence.map((e) => e.signal).join(", ")}`,
					budget,
				);

			case "real_bug":
				return routeRealBug(pool, runId, event, classification, budget, {
					lineage,
					settings,
					settingsError,
				});

			default:
				return escalate(
					pool,
					runId,
					event,
					"no_pattern_match",
					`Unknown classification category: ${classification.category}`,
					budget,
				);
		}
	} catch (err) {
		console.error(`[orchestrator] run ${runId} crashed:`, err);
		return escalate(
			pool,
			runId,
			event,
			"checkout_failed",
			`Pipeline error: ${String(err instanceof Error ? err.message : err)}`,
			budget,
		);
	}
}

// ── Route: flaky ─────────────────────────────────────────────────────

async function routeFlaky(
	pool: Pool,
	runId: string,
	event: CiEvent,
	_classification: ClassificationResult,
	budget: PipelineBudget,
): Promise<PipelineResult> {
	if (budget.isExpired()) {
		return escalate(
			pool,
			runId,
			event,
			"budget_exhausted",
			"Budget expired before retry.",
			budget,
		);
	}

	const retryResult = await retryFlaky(pool, {
		runId,
		repo: event.repo,
		externalRunId: event.external_run_id,
		jobId: event.job_id,
		jobName: event.job_name,
		commit: event.commit,
	});

	if (retryResult.resolved) {
		// Learn: this job failed and then passed on rerun → remember it as flaky.
		try {
			await addNote(
				pool,
				{ repo: event.repo, runId, source: "system", confidence: 0.55 },
				{
					kind: "flaky_hint",
					text: `Job "${event.job_name ?? "unknown"}" failed then passed on rerun (${retryResult.rerunsUsed}); treat similar failures as likely flaky.`,
					tags: [(event.job_name ?? "").toLowerCase()],
				},
			);
		} catch (err) {
			console.warn("[orchestrator] could not store flaky note:", err);
		}
		return { runId, path: "resolved" };
	}

	// Retries exhausted → escalate
	return escalate(
		pool,
		runId,
		event,
		"flaky_retries_exhausted",
		`Flaky failure persisted after ${retryResult.rerunsUsed} reruns.`,
		budget,
	);
}

// ── Lineage (re-fix loop) ────────────────────────────────────────────

export interface Lineage {
	/** 0 = first failure; n = n-th re-fix after a pushed fix did not make CI pass. */
	cycle: number;
	parentRunId?: string;
	/** Existing ci-fix branch to keep pushing to, when cycle > 0. */
	branch: string | null;
}

/**
 * A failure on `ci-fix/*` is the CI verdict on a fix we pushed. Find the run
 * that last pushed to that branch; this failure is its next re-fix cycle.
 */
export async function resolveLineage(
	pool: Pool,
	event: CiEvent,
): Promise<Lineage> {
	if (!event.branch.startsWith("ci-fix/")) return { cycle: 0, branch: null };
	const prev = await pool.query<{ run_id: string; fix_cycle: number }>(
		"SELECT run_id, fix_cycle FROM ci_runs WHERE repo = $1 AND fix_branch = $2 ORDER BY created_at DESC LIMIT 1",
		[event.repo, event.branch],
	);
	const p = prev.rows[0];
	if (!p) return { cycle: 0, branch: null };
	return {
		cycle: Number(p.fix_cycle) + 1,
		parentRunId: p.run_id,
		branch: event.branch,
	};
}

// ── Route: real_bug → AI agent → verified push, or escalate ──────────

async function routeRealBug(
	pool: Pool,
	runId: string,
	event: CiEvent,
	classification: ClassificationResult,
	budget: PipelineBudget,
	ctx: { lineage: Lineage; settings: Settings; settingsError: string | undefined },
): Promise<PipelineResult> {
	const { lineage, settings } = ctx;
	const limits = limitsFor(settings, event.repo);
	const repoCfg = repoSettings(settings, event.repo);

	// Guardrail: escalation cap for the re-fix loop.
	if (lineage.cycle > limits.maxFixCycles) {
		return escalate(
			pool,
			runId,
			event,
			"retry_cap_exceeded",
			`CI is still failing on '${event.branch}' after ${limits.maxFixCycles} re-fix cycle(s). Stopping instead of looping.`,
			budget,
		);
	}

	// Guardrail: protected branches are never touched.
	if (isCriticalBranch(event.branch)) {
		return escalate(
			pool,
			runId,
			event,
			"critical_branch",
			`Failure on critical branch '${event.branch}'. Manual review required.`,
			budget,
		);
	}

	if (budget.isExpired()) {
		return escalate(pool, runId, event, "budget_exhausted", "Budget expired before fix attempt.", budget);
	}

	// Brain: per-repo provider/model override > global default > env.
	const creds = credentialsFromEnv();
	let llm: ReturnType<typeof createLlmClient>;
	let choice: ReturnType<typeof resolveLlm>;
	try {
		if (ctx.settingsError) throw new Error(ctx.settingsError);
		choice = resolveLlm(settings, event.repo, creds);
		llm = createLlmClient(choice, creds);
	} catch (err) {
		return escalate(
			pool,
			runId,
			event,
			"llm_unavailable",
			String(err instanceof Error ? err.message : err),
			budget,
		);
	}
	await chainAgentEvent(pool, runId, "ci_agent_start", {
		phase: "provider_selected",
		provider: choice.provider,
		model: choice.model,
		origin: choice.origin,
		cycle: lineage.cycle,
	});

	const logText = await fetchJobLogs(event.repo, event.log_url);

	const queue = new CiQueue(pool);
	await queue.updateStatus(runId, "fixing");
	await chainRunTransition(pool, runId, "classifying", "fixing", {
		cycle: lineage.cycle,
	});

	const result = await attemptAgentFix({
		pool,
		runId,
		event,
		classification,
		logText,
		budget,
		llm,
		temperature: choice.temperature,
		limits,
		repoCfg,
		branch: lineage.branch ?? fixBranchName(runId),
		cycle: lineage.cycle,
		parentRunId: lineage.parentRunId,
		runsRoot: RUNS_ROOT,
		cacheDir: CACHE_DIR,
	});

	if (result.kind === "delivered") {
		await queue.updateStatus(runId, "resolved");
		await chainRunTransition(pool, runId, "fixing", "resolved", {
			branch: result.branch,
			commit: result.commitSha,
			...(result.fixPrUrl ? { pr_url: result.fixPrUrl } : {}),
		});
		console.log(
			`[orchestrator] run ${runId} fix pushed to ${result.branch} (cycle ${lineage.cycle}); waiting for CI on the branch`,
		);
		return { runId, path: "fix_delivered" };
	}
	return escalate(pool, runId, event, result.reason, result.summary, budget);
}

// ── Escalation helper ────────────────────────────────────────────────

async function escalate(
	pool: Pool,
	runId: string,
	event: CiEvent,
	reason: EscalationReason,
	summary: string,
	budget: PipelineBudget,
): Promise<PipelineResult> {
	const queue = new CiQueue(pool);
	await queue.updateStatus(runId, "escalated");

	const escalationEvidence = [
		`Reason: ${reason}`,
		`Budget remaining: ${budget.elapsedMs()}ms elapsed, ${budget.remainingLlmCalls()} LLM calls left`,
	].join("; ");

	await writeEscalation(pool, {
		runId,
		repo: event.repo,
		externalRunId: event.external_run_id,
		reason,
		summary,
		evidence: escalationEvidence,
	});

	return { runId, path: "escalated", reason };
}
