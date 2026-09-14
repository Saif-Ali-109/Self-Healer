// Central CI pipeline orchestrator — the integration hub.
// Wires: webhook → queue → worktree → classifier → route (retry / fix / escalate).
// Owns: orchestrator.ts (T024 + T027 + T033 + T037). Single writer — no other
// file modifies this module, satisfying the constitution's no-same-file rule.

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Pool } from "pg";
import {
	cleanupWorktree,
	setupWorktree,
	type WorktreeHandle,
} from "../../fleet/src/git/worktree.ts";
import { getPool } from "../db/pool.ts";
import { chainRunTransition } from "../sor/ciEvents.ts";
import type {
	CiEvent,
	ClassificationResult,
	EscalationReason,
} from "../types.ts";
import {
	FIX_CONFIDENCE_THRESHOLD,
	isCriticalBranch,
	MULTI_FILE_THRESHOLD,
} from "../types.ts";
import { PipelineBudget } from "../utils/budget.ts";
import { classify } from "./classifier/index.ts";
import { writeEscalation } from "./escalation/writer.ts";
import { matchPattern } from "./fixscope/allowlist.ts";
import { applyLintFix } from "./fixscope/lintfixer.ts";
import { fixBranchName, recordFixAttempt } from "./fixscope/record.ts";
import { CiQueue } from "./queue.ts";
import { retryFlaky } from "./retry/runner.ts";

const RUNS_ROOT = join(process.cwd(), ".runs");

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
): Promise<PipelineResult> {
	const pool = getPool();
	const queue = new CiQueue(pool);
	const budget = new PipelineBudget();

	// Enqueue (dedupe)
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
	const runId = enqueueResult.run_id!;

	try {
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
			classification = await classify(pool, runId, event.log_url);
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
				return routeRealBug(pool, runId, event, classification, budget);

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
		commit: event.commit,
	});

	if (retryResult.resolved) {
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

// ── Route: real_bug → guardrail → fix or escalate ────────────────────

async function routeRealBug(
	pool: Pool,
	runId: string,
	event: CiEvent,
	classification: ClassificationResult,
	budget: PipelineBudget,
): Promise<PipelineResult> {
	// Guardrail: confidence must be ≥ threshold
	if (classification.confidence < FIX_CONFIDENCE_THRESHOLD) {
		return escalate(
			pool,
			runId,
			event,
			"low_confidence",
			`Confidence ${classification.confidence} is below the ${FIX_CONFIDENCE_THRESHOLD} threshold.`,
			budget,
		);
	}

	// Guardrail: critical branch → never touch
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

	// Guardrail: multi-file (≥ 5 files) → too risky
	// Note: we don't have file count at this stage without checking the diff.
	// For MVP, we skip this check here and handle it in the fix verification stage
	// where we have the worktree diff available.

	// Budget check before fix
	if (budget.isExpired()) {
		return escalate(
			pool,
			runId,
			event,
			"budget_exhausted",
			"Budget expired before fix attempt.",
			budget,
		);
	}
	if (!budget.tickLlm()) {
		return escalate(
			pool,
			runId,
			event,
			"budget_exhausted",
			"LLM call budget exhausted.",
			budget,
		);
	}

	// Fetch logs for pattern matching
	const logText = await fetchLogText(event.log_url);

	// Guardrail: allowlist match required
	const pattern = matchPattern(logText);
	if (!pattern) {
		return escalate(
			pool,
			runId,
			event,
			"no_pattern_match",
			`Failure does not match any allowlisted fix pattern.`,
			budget,
		);
	}

	// ── Attempt the fix ────────────────────────────────────────────
	const fixResult = await attemptFix(
		pool,
		runId,
		event,
		pattern.id,
		pattern.verifyCommand,
		budget,
	);
	return fixResult;
}

// ── Fix attempt ──────────────────────────────────────────────────────

async function attemptFix(
	pool: Pool,
	runId: string,
	event: CiEvent,
	patternId: string,
	verifyCommand: string,
	budget: PipelineBudget,
): Promise<PipelineResult> {
	const queue = new CiQueue(pool);
	await queue.updateStatus(runId, "fixing");
	await chainRunTransition(pool, runId, "classifying", "fixing");

	// Set up worktree
	const runDir = join(RUNS_ROOT, runId);
	await mkdir(runDir, { recursive: true });
	const branch = fixBranchName(runId);

	let worktree: WorktreeHandle | undefined;
	try {
		// We need the repo URL — derive from the repo slug
		const repoUrl = `https://github.com/${event.repo}.git`;
		worktree = await setupWorktree(repoUrl, runDir, branch);
	} catch (err) {
		await queue.updateStatus(runId, "escalated");
		return escalate(
			pool,
			runId,
			event,
			"checkout_failed",
			`Could not set up worktree: ${String(err)}`,
			budget,
		);
	}
	if (!worktree) {
		return escalate(
			pool,
			runId,
			event,
			"checkout_failed",
			"Worktree setup returned no handle.",
			budget,
		);
	}

	try {
		// Apply the lint/format fix
		const fixResult = await applyLintFix(worktree, branch);

		// Guardrail: multi-file check on the diff
		const changedFilesList = fixResult.diff.split("\n").filter((l) => l.trim());
		if (changedFilesList.length >= MULTI_FILE_THRESHOLD) {
			return escalate(
				pool,
				runId,
				event,
				"multi_file",
				`Fix touches ${changedFilesList.length} files (≥ ${MULTI_FILE_THRESHOLD}). Too risky.`,
				budget,
			);
		}

		// Record the fix attempt (single attempt — DB unique enforces the cap)
		await recordFixAttempt(pool, {
			runId,
			patternMatched: patternId,
			diff: fixResult.diff,
			branch,
			verificationResult: fixResult.success ? "passed" : "failed",
			testSummary:
				fixResult.verificationOutput ||
				`${verifyCommand}: ${fixResult.success ? "passed" : "failed"}`,
		});

		if (fixResult.success) {
			// Post fix comment
			const { postFixComment } = await import("./comments.ts");
			const newCommentUrl = await postFixComment(
				event.repo,
				event.external_run_id,
				{
					rootCause: `Lint/format issues detected in the failing job.`,
					pattern: patternId,
					branch,
					diffSummary: `${fixResult.filesChanged} files changed`,
					verification: `${verifyCommand}: passed`,
				},
			);
			if (newCommentUrl) {
				await pool.query(
					"UPDATE fix_attempts SET comment_url = $1 WHERE run_id = $2",
					[newCommentUrl, runId],
				);
			}
			await queue.updateStatus(runId, "resolved");
			await chainRunTransition(pool, runId, "fixing", "resolved");
			console.log(`[orchestrator] run ${runId} fix delivered on ${branch}`);
			return { runId, path: "fix_delivered" };
		}

		// Verification failed → escalate, never retry
		return escalate(
			pool,
			runId,
			event,
			"fix_failed",
			`Fix applied but verification failed. Diff: ${fixResult.diff.slice(0, 200)}`,
			budget,
		);
	} finally {
		// Clean up worktree
		await cleanupWorktree(worktree).catch(() => {});
	}
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

// ── Log fetching ─────────────────────────────────────────────────────

async function fetchLogText(logUrl: string): Promise<string> {
	try {
		const { execFile } = await import("node:child_process");
		const { promisify } = await import("node:util");
		const exec = promisify(execFile);
		const match = logUrl.match(/\/jobs\/(\d+)$/);
		if (!match) return "";
		const result = await exec(
			"gh",
			["api", `repos/{owner}/{repo}/actions/jobs/${match[1]}/logs`],
			{ maxBuffer: 32 * 1024 * 1024 },
		);
		return result.stdout ?? "";
	} catch {
		return "";
	}
}
