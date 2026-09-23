// Fix-only pull request delivery (constitution v1.2.0 — Human-Approved Delivery).
// After a verified auto-fix, open ONE PR from `ci-fix/<run-id>` → the failing
// branch so a human can review/approve it through the normal GitHub flow.
// The agent NEVER merges and NEVER pushes to protected branches.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Pool } from "../../db/pool.ts";

const exec = promisify(execFile);

async function gh(args: string[]): Promise<string> {
	const { stdout } = await exec("gh", args, { maxBuffer: 32 * 1024 * 1024 });
	return stdout;
}

/** Title for the fix-only pull request. */
export function buildFixPrTitle(externalRunId: string): string {
	return `🤖 Self-Healer: auto-fix for CI run #${externalRunId}`;
}

export interface FixPrBodyInput {
	externalRunId: string;
	/** Legacy allowlist pattern name (v1.x fixers). Omitted for AI-agent fixes. */
	pattern?: string;
	/** AI-agent extras (all optional so legacy callers/tests are unaffected). */
	rootCause?: string;
	summary?: string;
	reasoning?: string;
	model?: string;
	cycle?: number;
	maxCycles?: number;
	warnings?: string[];
	branch: string;
	baseBranch: string;
	diffSummary: string;
	verification: string;
}

/** Human-readable fix PR body — review-first; the agent never merges. */
export function buildFixPrBody(opts: FixPrBodyInput): string {
	const lines = [
		"## 🤖 Self-Healer: automated fix",
		"",
		`This PR was opened automatically for failing CI run \`#${opts.externalRunId}\`.`,
		"",
		...(opts.rootCause ? [`**Root cause**: ${opts.rootCause}`, ""] : []),
		...(opts.pattern ? [`**Pattern matched**: \`${opts.pattern}\``, ""] : []),
		...(opts.summary ? [`**What changed**: ${opts.summary}`, ""] : []),
		...(opts.reasoning
			? [`**Agent reasoning**: ${opts.reasoning.slice(0, 1200)}`, ""]
			: []),
		...(opts.cycle !== undefined && opts.cycle > 0
			? [
					`**Re-fix cycle**: ${opts.cycle} of ${opts.maxCycles ?? "?"} (an earlier fix on this branch did not make CI pass)`,
					"",
				]
			: []),
		...(opts.model ? [`**Model**: \`${opts.model}\``, ""] : []),
		...(opts.warnings && opts.warnings.length > 0
			? [...opts.warnings.map((w) => `> ⚠️ ${w}`), ""]
			: []),
		`**Branch**: \`${opts.branch}\``,
		`**Base**: \`${opts.baseBranch}\``,
		`**Diff summary**: ${opts.diffSummary}`,
		`**Verification**: ${opts.verification}`,
		"",
		"> The agent never merges. Review, approve, and merge when ready.",
	].join("\n");
	return lines;
}

export interface OpenFixPrInput {
	runId: string;
	repo: string;
	externalRunId: string;
	headBranch: string;
	baseBranch: string;
	pattern?: string;
	rootCause?: string;
	summary?: string;
	reasoning?: string;
	model?: string;
	cycle?: number;
	maxCycles?: number;
	warnings?: string[];
	diffSummary: string;
	verification: string;
}

/**
 * Open a fix-only PR from `headBranch` (ci-fix/<run-id>) to `baseBranch`
 * (the failing branch) so a human can approve it via normal GitHub review.
 * Best-effort and NON-FATAL with a small retry (the sandbox's api.github.com
 * link is flaky): any persistent failure warns and returns null — the fix
 * comment delivery still proceeds. Never merges.
 */
export async function openFixPr(
	pool: Pool,
	opts: OpenFixPrInput,
): Promise<string | null> {
	// Offline/dry-run mode: never hit api.github.com.
	if (
		process.env.CI_POST_COMMENTS === "0" ||
		process.env.CI_POST_COMMENTS === "false"
	) {
		return null;
	}
	// A PR needs a distinct base: re-fix cycles fail on the same ci-fix branch,
	// so those falls back to branch + comment (never a head==base PR).
	if (opts.headBranch === opts.baseBranch) return null;
	const MAX_ATTEMPTS = 3;
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		try {
			// Idempotency: reuse an existing open PR for this head branch.
			const existing = await gh([
				"api",
				`repos/${opts.repo}/pulls?state=open&per_page=100`,
				"--jq",
				`[.[] | select(.head.ref == "${opts.headBranch}") | .html_url][0]`,
			]);
			if (existing.trim()) return existing.trim();

			const body = buildFixPrBody({
				externalRunId: opts.externalRunId,
				pattern: opts.pattern,
				rootCause: opts.rootCause,
				summary: opts.summary,
				reasoning: opts.reasoning,
				model: opts.model,
				cycle: opts.cycle,
				maxCycles: opts.maxCycles,
				warnings: opts.warnings,
				branch: opts.headBranch,
				baseBranch: opts.baseBranch,
				diffSummary: opts.diffSummary,
				verification: opts.verification,
			});
			const url = await gh([
				"api",
				`repos/${opts.repo}/pulls`,
				"--method",
				"POST",
				"-f",
				`title=${buildFixPrTitle(opts.externalRunId)}`,
				"-f",
				`head=${opts.headBranch}`,
				"-f",
				`base=${opts.baseBranch}`,
				"-f",
				`body=${body}`,
				"--jq",
				".html_url",
			]);
			const htmlUrl = url.trim();
			if (!htmlUrl) return null;

			await pool.query(
				"UPDATE fix_attempts SET fix_pr_url = $1 WHERE run_id = $2",
				[htmlUrl, opts.runId],
			);
			console.log(
				`[fixpr] opened fix PR ${htmlUrl} (${opts.headBranch} → ${opts.baseBranch})`,
			);
			return htmlUrl;
		} catch (err) {
			console.warn(
				`[fixpr] attempt ${attempt}/${MAX_ATTEMPTS} failed to open fix PR (non-fatal):`,
				err,
			);
			if (attempt < MAX_ATTEMPTS) {
				await sleep(attempt * 2_000); // 2s, 4s backoff
			}
		}
	}
	return null;
}

const sleep = (ms: number): Promise<void> =>
	new Promise((r) => setTimeout(r, ms));