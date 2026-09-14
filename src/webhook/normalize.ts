import type { CiEvent } from "../types.ts";

/**
 * Validate and coerce unknown JSON into a canonical CiEvent.
 * Returns { error } for invalid payloads, or the validated CiEvent.
 */
export function validateCiEvent(raw: unknown): CiEvent | { error: string } {
	if (!raw || typeof raw !== "object")
		return { error: "payload is not an object" };
	const r = raw as Record<string, unknown>;
	// Required fields check
	const required = [
		"repo",
		"commit",
		"branch",
		"external_run_id",
		"job_id",
		"job_name",
		"status",
		"log_url",
		"delivered_at",
	] as const;
	for (const k of required) {
		if (typeof r[k] !== "string" || (r[k] as string).trim() === "")
			return { error: `missing or empty field: ${k}` };
	}
	if (r.status !== "failed")
		return { error: "only 'failed' status is accepted" };
	// Validate commit is 40-char hex
	if (!/^[0-9a-f]{40}$/i.test(r.commit as string))
		return { error: "commit must be a 40-char hex SHA" };
	return {
		repo: r.repo as string,
		commit: r.commit as string,
		branch: r.branch as string,
		external_run_id: r.external_run_id as string,
		job_id: r.job_id as string,
		job_name: r.job_name as string,
		status: "failed",
		log_url: r.log_url as string,
		artifact_url:
			typeof r.artifact_url === "string" ? r.artifact_url : undefined,
		delivered_at: r.delivered_at as string,
	};
}
