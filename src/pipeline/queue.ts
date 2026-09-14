import type { Pool, QueryResult } from "pg";
import type { CiEvent, CiRunStatus } from "../types.ts";

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
	constructor(private pool: Pool) {}

	async enqueue(ev: CiEvent): Promise<EnqueueResult> {
		try {
			const result: QueryResult<{ run_id: string }> = await this.pool.query(
				`INSERT INTO ci_runs (external_run_id, repo, commit, branch, job_id, job_name, status, log_url, artifact_url, created_at)
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
}
