import type { Pool } from "../../db/pool.ts";
import { chainCiEvent } from "../../sor/ciEvents.ts";
import type { FixAttemptRecord, FixVerificationResult } from "../../types.ts";

/**
 * Generate the reusable fix branch name for a CI run.
 * Format: `ci-fix/<run-id>` (first 8 chars of UUID).
 */
export function fixBranchName(runId: string): string {
	return `ci-fix/${runId.slice(0, 8)}`;
}

/**
 * Persist a fix attempt to the database and chain to SOR.
 * Enforces the one-attempt cap via the UNIQUE constraint on run_id.
 */
export async function recordFixAttempt(
	pool: Pool,
	opts: {
		runId: string;
		patternMatched: string;
		diff: string;
		branch: string;
		verificationResult: FixVerificationResult;
		testSummary?: string;
		commentUrl?: string;
		/** Agent-era context (used to brief re-fix cycles). */
		rootCause?: string;
		summary?: string;
		filesChanged?: string[];
		model?: string;
	},
): Promise<FixAttemptRecord> {
	const record: FixAttemptRecord = {
		run_id: opts.runId,
		pattern_matched: opts.patternMatched,
		diff: opts.diff,
		branch: opts.branch,
		verification_result: opts.verificationResult,
		test_summary: opts.testSummary,
		comment_url: opts.commentUrl,
		attempted_at: new Date().toISOString(),
	};

	// Persist to fix_attempts (UNIQUE on run_id enforces 1 attempt)
	try {
		await pool.query(
			`INSERT INTO fix_attempts (run_id, pattern_matched, diff, branch, verification_result, test_summary, comment_url, root_cause, summary, files_changed, model, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
       ON CONFLICT (run_id) DO UPDATE SET
         verification_result = EXCLUDED.verification_result,
         test_summary = EXCLUDED.test_summary,
         comment_url = EXCLUDED.comment_url,
         root_cause = COALESCE(EXCLUDED.root_cause, fix_attempts.root_cause),
         summary = COALESCE(EXCLUDED.summary, fix_attempts.summary),
         files_changed = COALESCE(EXCLUDED.files_changed, fix_attempts.files_changed),
         model = COALESCE(EXCLUDED.model, fix_attempts.model)`,
			[
				opts.runId,
				opts.patternMatched,
				opts.diff,
				opts.branch,
				opts.verificationResult,
				opts.testSummary ?? null,
				opts.commentUrl ?? null,
				opts.rootCause ?? null,
				opts.summary ?? null,
				opts.filesChanged ? opts.filesChanged.join("\n") : null,
				opts.model ?? null,
			],
		);
	} catch (err) {
		console.error("[fixscope] failed to persist fix attempt:", err);
	}

	// Chain to SOR
	await chainCiEvent(pool, opts.runId, "ci_fix_attempt", {
		pattern_matched: opts.patternMatched,
		branch: opts.branch,
		verification_result: opts.verificationResult,
		diff_lines: opts.diff.split("\n").length,
	});

	return record;
}
