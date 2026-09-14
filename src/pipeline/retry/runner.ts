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
 * Retry a flaky CI job up to MAX_RERUNS times via the GitHub Actions rerun API.
 *
 * For each attempt:
 *   1. Update ci_runs.status → 'retrying'
 *   2. Call `gh api repos/{repo}/actions/runs/{runId}/rerun-failed-jobs`
 *   3. Poll job status via `gh api repos/{repo}/actions/jobs/{jobId}` until completed
 *   4. If conclusion === 'success' → resolved; break
 *   5. If not → continue rerunning (up to MAX_RERUNS)
 *
 * On resolution: post flaky-resolved comment, chain SOR event, update status → 'resolved'
 * On exhaustion: update status → 'escalated' (caller should then invoke escalation writer)
 */
export async function retryFlaky(
	pool: Pool,
	opts: {
		runId: string;
		repo: string;
		externalRunId: string;
		jobId: string;
		commit: string;
		logUrl?: string;
	},
): Promise<RetryResult> {
	const queue = new CiQueue(pool);

	for (let attempt = 1; attempt <= MAX_RERUNS; attempt++) {
		console.log(
			`[retry] rerun ${attempt}/${MAX_RERUNS} for run ${opts.externalRunId}`,
		);

		// Update status
		await queue.updateStatus(opts.runId, "retrying");
		await chainCiEvent(pool, opts.runId, "ci_run_transition", {
			from: "retrying",
			attempt,
		});

		try {
			// Trigger rerun via GitHub API
			await gh([
				"api",
				`repos/${opts.repo}/actions/runs/${opts.externalRunId}/rerun-failed-jobs`,
				"--method",
				"POST",
			]);
		} catch (err) {
			console.error(`[retry] rerun API call failed (attempt ${attempt}):`, err);
			// Non-fatal: we still wait and check — the run might already be running
		}

		// Poll for job completion (up to 5 minutes per attempt, 10s interval)
		const completed = await pollJobCompletion(
			opts.repo,
			opts.jobId,
			5 * 60 * 1000,
		);

		if (completed && completed.conclusion === "success") {
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
			`[retry] rerun ${attempt} still failed (conclusion: ${completed?.conclusion ?? "unknown"})`,
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

/**
 * Poll a GitHub Actions job until it completes or the timeout expires.
 * Returns the job's conclusion ('success'|'failure'|'cancelled'|null) or null on timeout.
 */
async function pollJobCompletion(
	repo: string,
	jobId: string,
	timeoutMs: number,
): Promise<{ conclusion: string | null } | null> {
	const deadline = Date.now() + timeoutMs;
	const pollInterval = 10_000; // 10 seconds

	while (Date.now() < deadline) {
		try {
			const raw = await gh([
				"api",
				`repos/${repo}/actions/jobs/${jobId}`,
				"--jq",
				"{conclusion: .conclusion, status: .status}",
			]);
			const job = JSON.parse(raw) as {
				conclusion: string | null;
				status: string;
			};
			if (job.status === "completed") {
				return { conclusion: job.conclusion };
			}
		} catch {
			// Non-fatal: keep polling
		}
		await sleep(pollInterval);
	}
	return null; // timeout
}
