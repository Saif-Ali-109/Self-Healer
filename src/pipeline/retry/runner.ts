import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Pool } from "pg";
import { chainCiEvent } from "../../sor/ciEvents.ts";
import { MAX_RERUNS } from "../../types.ts";
import { postFlakyResolvedComment } from "../comments.ts";
import { CiQueue } from "../queue.ts";

const exec = promisify(execFile);

/** Run a gh CLI command. Throws on failure. */
async function gh(args: string[], cwd?: string): Promise<string> {
	const { stdout } = await exec("gh", args, {
		cwd,
		maxBuffer: 32 * 1024 * 1024,
	});
	return stdout;
}

/** Sleep for ms milliseconds. */
const sleep = (ms: number): Promise<void> =>
	new Promise((r) => setTimeout(r, ms));

export interface RetryResult {
	resolved: boolean;
	rerunsUsed: number;
	reason: string;
}

/**
 * Retry a flaky CI job up to MAX_RERUNS times.
 *
 * Reruns ONLY the failing job (`actions/jobs/{id}/rerun`) — never
 * `rerun-failed-jobs`, which restarts every failed job in the run and, because
 * each re-completion re-fires the reporter, amplifies CI churn across rerun
 * cycles. After each POST we wait for the workflow RUN to complete a NEW
 * attempt (run_attempt must advance) before issuing the next rerun, so we never
 * race the previous rerun the way polling the stale job ID did (which caused
 * `This workflow is already running (HTTP 403)` on every attempt ≥ 2).
 *
 * For each attempt:
 *   1. Update ci_runs.status → 'retrying'
 *   2. `gh api repos/{repo}/actions/jobs/{jobId}/rerun` (single job)
 *   3. Poll the run until status=completed AND run_attempt > attemptBefore
 *   4. Fetch the newest job instance with this name; conclusion === 'success' → resolved
 *   5. Otherwise continue (up to MAX_RERUNS)
 *
 * On resolution: post flaky-resolved comment, chain SOR event, status → 'resolved'
 * On exhaustion: status → 'escalated' (caller then invokes the escalation writer)
 */
export async function retryFlaky(
	pool: Pool,
	opts: {
		runId: string;
		repo: string;
		externalRunId: string;
		jobId: string;
		jobName: string;
		commit: string;
		logUrl?: string;
	},
): Promise<RetryResult> {
	const queue = new CiQueue(pool);

	for (let attempt = 1; attempt <= MAX_RERUNS; attempt++) {
		console.log(
			`[retry] rerun ${attempt}/${MAX_RERUNS} for run ${opts.externalRunId} job ${opts.jobName}`,
		);

		// Update status
		await queue.updateStatus(opts.runId, "retrying");
		await chainCiEvent(pool, opts.runId, "ci_run_transition", {
			from: "retrying",
			attempt,
		});

		// Snapshot the current attempt so we can detect our rerun completing.
		const attemptBefore = await getRunAttempt(opts.repo, opts.externalRunId);

		try {
			// Trigger a rerun of ONLY this job
			await gh([
				"api",
				`repos/${opts.repo}/actions/jobs/${opts.jobId}/rerun`,
				"--method",
				"POST",
			]);
		} catch (err) {
			console.error(`[retry] rerun API call failed (attempt ${attempt}):`, err);
			// Non-fatal: we still wait and check — the run might already be running
		}

		// Wait for the rerun's attempt to actually complete (up to 5 min, 10s interval)
		const completedAttempt = await pollRunForRerun(
			opts.repo,
			opts.externalRunId,
			attemptBefore,
			5 * 60 * 1000,
		);
		if (completedAttempt === null) {
			console.warn(
				`[retry] rerun ${attempt} did not observe a completed attempt (timeout)`,
			);
			continue;
		}

		const rerunConclusion = await jobConclusionForRun(
			opts.repo,
			opts.externalRunId,
			opts.jobName,
		);

		if (rerunConclusion === "success") {
			// Resolved!
			await queue.updateStatus(opts.runId, "resolved");
			await chainCiEvent(pool, opts.runId, "ci_run_transition", {
				from: "retrying",
				to: "resolved",
				attempt,
			});
			await postFlakyResolvedComment(opts.repo, opts.externalRunId, {
				rerunNumber: attempt,
				commit: opts.commit,
			});

			console.log(`[retry] resolved on rerun ${attempt}/${MAX_RERUNS}`);
			return {
				resolved: true,
				rerunsUsed: attempt,
				reason: `passed on rerun ${attempt}`,
			};
		}

		console.log(
			`[retry] rerun ${attempt} still failed (conclusion: ${rerunConclusion ?? "unknown"})`,
		);
	}

	// Exhausted all reruns
	await queue.updateStatus(opts.runId, "escalated");
	await chainCiEvent(pool, opts.runId, "ci_run_transition", {
		from: "retrying",
		to: "escalated",
		reason: "flaky_retries_exhausted",
	});
	console.log(
		`[retry] exhausted ${MAX_RERUNS} reruns for run ${opts.externalRunId}`,
	);

	return {
		resolved: false,
		rerunsUsed: MAX_RERUNS,
		reason: "flaky_retries_exhausted",
	};
}

/** Current run_attempt of a workflow run (0 if unknown). */
async function getRunAttempt(repo: string, runId: string): Promise<number> {
	try {
		const raw = await gh([
			"api",
			`repos/${repo}/actions/runs/${runId}`,
			"--jq",
			".run_attempt",
		]);
		const n = Number.parseInt(raw.trim(), 10);
		return Number.isFinite(n) ? n : 0;
	} catch {
		return 0;
	}
}

/**
 * Wait until the workflow run completes a NEW attempt (run_attempt greater than
 * `attemptBefore`), i.e. our single-job rerun actually ran to completion.
 * Returns the new run_attempt, or null on timeout.
 */
async function pollRunForRerun(
	repo: string,
	runId: string,
	attemptBefore: number,
	timeoutMs: number,
): Promise<number | null> {
	const deadline = Date.now() + timeoutMs;
	const pollInterval = 10_000; // 10 seconds

	while (Date.now() < deadline) {
		try {
			const raw = await gh([
				"api",
				`repos/${repo}/actions/runs/${runId}`,
				"--jq",
				"{attempt: .run_attempt, status: .status}",
			]);
			const run = JSON.parse(raw) as { attempt?: number; status: string };
			if (run.status === "completed" && (run.attempt ?? 0) > attemptBefore) {
				return run.attempt ?? null;
			}
		} catch {
			// Non-fatal: keep polling
		}
		await sleep(pollInterval);
	}
	return null; // timeout
}

/**
 * After a rerun completes, find the newest job instance in the run matching
 * `jobName` and return its conclusion ('success' | 'failure' | null).
 * Single-job reruns re-create the job (new ID, same name), so the newest
 * instance by started_at is the result of our rerun.
 */
async function jobConclusionForRun(
	repo: string,
	runId: string,
	jobName: string,
): Promise<string | null> {
	try {
		const raw = await gh([
			"api",
			`repos/${repo}/actions/runs/${runId}/jobs`,
			"--paginate",
			"--jq",
			`[.jobs[] | select(.name == "${jobName}")] | sort_by(.started_at) | last | .conclusion`,
		]);
		const c = raw.trim();
		return c && c !== "null" ? c : null;
	} catch {
		return null;
	}
}
