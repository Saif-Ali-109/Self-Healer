import type { Pool, QueryResult } from "../db/pool.ts";
import type { CiEvent, CiRunStatus } from "../types.ts";
import { chainCiEvent } from "../sor/ciEvents.ts";

export interface EnqueueResult {
	ok: boolean;
	duplicate?: boolean;
	run_id?: string;
}

/**
 * Enqueue a CI failure event. Inserts a ci_runs row with status 'pending'.
 * Uses the unique index (external_run_id, repo, job_id) for deduplication.
 */
export class CiQueue {
	declare private pool: Pool;

	constructor(pool: Pool) {
		this.pool = pool;
	}

	async enqueue(ev: CiEvent): Promise<EnqueueResult> {
		// Per-job-name dedup: the reporter re-fires on every workflow-run
		// completion during rerun cycles — the same failure keeps arriving with
		// NEW job IDs but the SAME job name. One handling per (run, job name) is
		// enough; later re-fires are duplicates. (If the event has no job name,
		// fall back to the (external_run_id, repo, job_id) unique index below.)
		if (ev.job_name) {
			const existing = await this.pool.query(
				"SELECT 1 FROM ci_runs WHERE external_run_id = $1 AND repo = $2 AND job_name = $3 LIMIT 1",
				[ev.external_run_id, ev.repo, ev.job_name],
			);
			if ((existing.rowCount ?? 0) > 0) {
				return { ok: true, duplicate: true };
			}
		}

		try {
			const result: QueryResult<{ run_id: string }> = await this.pool.query(
				`INSERT INTO ci_runs (external_run_id, repo, "commit", branch, job_id, job_name, status, log_url, artifact_url, created_at)
				 VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8, now())
				 RETURNING run_id`,
				[
					ev.external_run_id,
					ev.repo,
					ev.commit,
					ev.branch,
					ev.job_id,
					ev.job_name,
					ev.log_url,
					ev.artifact_url ?? null,
				],
			);
			return { ok: true, run_id: result.rows[0]?.run_id };
		} catch (err: unknown) {
			// Unique violation = duplicate event (code 23505)
			const code = (err as { code?: string }).code;
			if (code === "23505") return { ok: true, duplicate: true };
			console.error("[queue] enqueue failed:", err);
			return { ok: false };
		}
	}

	/** Update the status of a ci_run row (forward-only transitions). */
	async updateStatus(runId: string, status: CiRunStatus): Promise<void> {
		const setClauses: string[] = ["status = $1"];
		if (status === "resolved" || status === "escalated") {
			setClauses.push("completed_at = now()");
		}
		await this.pool.query(
			`UPDATE ci_runs SET ${setClauses.join(", ")} WHERE run_id = $2`,
			[status, runId],
		);
	}

	/**
	 * Processing-time dedup: one handling cycle per (repo, external_run_id,
	 * job_name). If ANY other row already exists for the same failure (same run
	 * id + job name — the reporter re-fires those with new job IDs on every
	 * workflow-run completion during rerun cycles), the pending row is a
	 * duplicate re-fire and must be skipped, never re-processed.
	 */
	async isHandledDuplicate(
		ev: CiEvent,
		excludeRunId: string,
	): Promise<boolean> {
		if (!ev.job_name) return false;
		const existing = await this.pool.query(
			"SELECT 1 FROM ci_runs WHERE external_run_id = $1 AND repo = $2 AND job_name = $3 AND run_id != $4 LIMIT 1",
			[ev.external_run_id, ev.repo, ev.job_name, excludeRunId],
		);
		return (existing.rowCount ?? 0) > 0;
	}

	/** Mark a duplicate re-fire row as skipped (terminal, no side effects). */
	async markSkipped(runId: string, reason: string): Promise<void> {
		await this.pool.query(
			`UPDATE ci_runs SET status = 'skipped', completed_at = now()
			 WHERE run_id = $1 AND status = 'pending'`,
			[runId],
		);
		await chainCiEvent(this.pool, runId, "ci_run_transition", {
			from: "pending",
			to: "skipped",
			reason,
		});
	}
}
