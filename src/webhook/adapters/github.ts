import type { CiEvent } from "../../types.ts";

/**
 * Map a GitHub Actions workflow_job event payload into the canonical CiEvent.
 * Checks X-GitHub-Event header is 'workflow_job'.
 * Maps: repository.full_name, workflow_job.head_sha/branch/id/name/conclusion/check_run_url,
 * workflow_run.id → external_run_id.
 */
export function mapGitHubActions(
	payload: unknown,
	headers: Record<string, string | string[] | undefined>,
): CiEvent | { error: string } {
	// Validate event type header
	const eventType = Array.isArray(headers["x-github-event"])
		? headers["x-github-event"][0]
		: headers["x-github-event"];
	if (!eventType || eventType !== "workflow_job")
		return { error: `unsupported event type: ${eventType ?? "missing"}` };

	if (!payload || typeof payload !== "object")
		return { error: "payload is not an object" };
	const p = payload as Record<string, unknown>;
	const wj = p.workflow_job as Record<string, unknown> | undefined;
	const wr = p.workflow_run as Record<string, unknown> | undefined;
	const repo = p.repository as Record<string, unknown> | undefined;
	if (!wj || !wr || !repo)
		return { error: "missing workflow_job, workflow_run, or repository" };

	const conclusion = wj.conclusion;
	if (conclusion !== "failure")
		return { error: `ignoring conclusion: ${conclusion}` };

	const repoName = repo.full_name;
	if (typeof repoName !== "string")
		return { error: "repository.full_name missing" };

	const commit = wj.head_sha;
	const branch = wj.head_branch;
	const runId = wr.id;
	const jobId = wj.id;
	const jobName = wj.name;
	const logUrl = wj.check_run_url;

	// Validate required fields
	for (const [label, val] of [
		["commit", commit],
		["branch", branch],
		["runId", runId],
		["jobId", jobId],
		["jobName", jobName],
		["logUrl", logUrl],
	] as const) {
		if (
			val === undefined ||
			val === null ||
			(typeof val === "string" && val.trim() === "")
		)
			return { error: `workflow_job/workflow_run missing field: ${label}` };
	}

	return {
		repo: repoName,
		commit: String(commit),
		branch: String(branch),
		external_run_id: String(runId),
		job_id: String(jobId),
		job_name: String(jobName),
		status: "failed",
		log_url: String(logUrl),
		delivered_at: new Date().toISOString(),
	};
}
