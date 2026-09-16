import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { EscalationReason } from "../types.ts";

const exec = promisify(execFile);

async function gh(args: string[]): Promise<string> {
	const { stdout } = await exec("gh", args, { maxBuffer: 32 * 1024 * 1024 });
	return stdout;
}

/** Strip any token/key patterns from text. Never log secrets. */
export function redactSecrets(text: string): string {
	return text
		.replace(/gh[pous]_[A-Za-z0-9_]{36,}/g, "***")
		.replace(/github_pat_[A-Za-z0-9_]{50,}/g, "***")
		.replace(/sk-[A-Za-z0-9]{20,}/g, "***");
}

/**
 * Choose where a comment should land for a workflow run.
 * GitHub has no `actions/runs/{id}/comments` endpoint (it 404s), so we attach
 * to the run's pull request if one exists, else to the head commit.
 * Returns an API path suffix like `issues/42` or `commits/<sha>`, or null when
 * no target is available.
 */
export function pickCommentTarget(
	pullRequestNumbers: ReadonlyArray<number> | undefined,
	commitSha: string,
): string | null {
	if (pullRequestNumbers && pullRequestNumbers.length > 0)
		return `issues/${pullRequestNumbers[0]}`;
	if (commitSha) return `commits/${commitSha}`;
	return null;
}

/** Fetch PR numbers + head SHA for an Actions run (best-effort). */
async function fetchRunTarget(
	repo: string,
	externalRunId: string,
): Promise<string | null> {
	const prs = await gh([
		"api",
		`repos/${repo}/actions/runs/${externalRunId}`,
		"--jq",
		`[.pull_requests[].number] | join(",")`,
	]);
	const numbers = prs
		.trim()
		.split(",")
		.filter(Boolean)
		.map((n) => Number(n));

	const headSha = (
		await gh([
			"api",
			`repos/${repo}/actions/runs/${externalRunId}`,
			"--jq",
			".head_sha",
		])
	).trim();
	return pickCommentTarget(numbers, headSha);
}

async function postComment(
	repo: string,
	externalRunId: string,
	body: string,
): Promise<string | null> {
	// Dry-run mode: never hit api.github.com (tests, local demos). Comment
	// posting is best-effort anyway, so skipping is harmless.
	if (
		process.env.CI_POST_COMMENTS === "0" ||
		process.env.CI_POST_COMMENTS === "false"
	) {
		return null;
	}
	const redacted = redactSecrets(body);
	try {
		const target = await fetchRunTarget(repo, externalRunId);
		if (!target) {
			console.warn("[comments] no comment target (no PR and no head_sha)");
			return null;
		}
		const result = await gh([
			"api",
			`repos/${repo}/${target}/comments`,
			"--method",
			"POST",
			"-f",
			`body=${redacted}`,
			"--jq",
			".html_url",
		]);
		return result.trim() || null;
	} catch (err) {
		console.warn("[comments] failed to post comment:", err);
		return null;
	}
}

export interface FixCommentOptions {
	rootCause: string;
	pattern: string;
	branch: string;
	diffSummary: string;
	verification: string;
	/** Fix-only PR URL, when one was opened for review (constitution v1.2.0). */
	fixPrUrl?: string;
}

/**
 * Build the "fix delivered" comment body (contracts/ci-comment.md type 1).
 * Pure string builder — testable without a repo.
 */
export function buildFixCommentBody(opts: FixCommentOptions): string {
	return [
		"## 🤖 Self-Healer: fix proposed (auto-fix)",
		"",
		`**Root cause**: ${opts.rootCause}`,
		"",
		`**Pattern matched**: \`${opts.pattern}\``,
		"",
		`**Branch**: \`${opts.branch}\``,
		`**Diff summary**: ${opts.diffSummary}`,
		`**Verification**: ${opts.verification}`,
		...(opts.fixPrUrl
			? ["", `**Pull request**: ${opts.fixPrUrl} — review & merge when ready.`]
			: []),
		"",
		"> Review and merge at your discretion. The agent never merges.",
	].join("\n");
}

/**
 * Post a "fix delivered" comment (contracts/ci-comment.md type 1).
 */
export async function postFixComment(
	repo: string,
	externalRunId: string,
	opts: FixCommentOptions,
): Promise<string | null> {
	return postComment(repo, externalRunId, buildFixCommentBody(opts));
}

/**
 * Post an escalation comment (contracts/ci-comment.md type 2).
 * Format:
 *   ## 🤖 Self-Healer: needs a human (escalation)
 *   **Reason**: `low_confidence`
 *   **Root cause**: ...
 *   **Suggested next step**: ...
 *   **Evidence**: ...
 */
export async function postEscalationComment(
	repo: string,
	externalRunId: string,
	opts: {
		reason: EscalationReason;
		summary: string;
		suggestedNextStep: string;
		evidence: string;
	},
): Promise<string | null> {
	const body = [
		"## 🤖 Self-Healer: needs a human (escalation)",
		"",
		`**Reason**: \`${opts.reason}\``,
		"",
		`**Root cause**: ${opts.summary}`,
		"",
		`**Suggested next step**: ${opts.suggestedNextStep}`,
		"",
		`**Evidence**: ${opts.evidence}`,
	].join("\n");
	return postComment(repo, externalRunId, body);
}

/**
 * Post a "flaky resolved" comment (contracts/ci-comment.md type 3).
 * Format:
 *   ## 🤖 Self-Healer: flaky failure recovered
 *   The failing job **passed on rerun N/3** for `#<run-id>` (commit `<sha>`).
 *   No action needed.
 */
export async function postFlakyResolvedComment(
	repo: string,
	externalRunId: string,
	opts: { rerunNumber: number; commit: string },
): Promise<string | null> {
	const body = [
		"## 🤖 Self-Healer: flaky failure recovered",
		"",
		`The failing job **passed on rerun ${opts.rerunNumber}/${3}** for \`#${externalRunId}\` (commit \`${opts.commit}\`).`,
		"",
		"No action needed.",
	].join("\n");
	return postComment(repo, externalRunId, body);
}