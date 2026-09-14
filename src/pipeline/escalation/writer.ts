import type { Pool } from "pg";
import { chainCiEvent } from "../../sor/ciEvents.ts";
import type { EscalationReason, EscalationRecord } from "../../types.ts";
import { postEscalationComment } from "../comments.ts";

/**
 * Suggested next steps per escalation reason (contracts/fix-attempt.md mapping).
 */
const NEXT_STEPS: Record<EscalationReason, string> = {
	low_confidence:
		"Review the failure logs manually; the classifier could not determine a clear root cause with ≥ 0.7 confidence.",
	fix_failed:
		"The auto-fix was applied but verification failed. Review the ci-fix branch and fix manually.",
	multi_file:
		"The failure involves 5+ files; this requires manual triage to determine the root cause.",
	critical_branch:
		"This failure is on a protected branch (main/release/v*). Manual review required before any changes.",
	budget_exhausted:
		"The 10-minute pipeline budget or 3-call LLM cap was exhausted. Investigate logs for time/model issues.",
	no_pattern_match:
		"The failure does not match any allowlisted fix pattern. Manual investigation required.",
	infra:
		"Infrastructure failure detected (rate limit, disk full, Docker, credentials). Check CI platform status.",
	flaky_retries_exhausted:
		"Flaky failure persisted after 3 reruns. The test may need to be fixed or skipped.",
	checkout_failed:
		"Could not check out the failing commit. Verify the repository and commit SHA are valid.",
};

/** Suggested next step for an escalation reason (contracts/fix-attempt.md mapping). */
export function suggestedNextStepFor(reason: EscalationReason): string {
	return NEXT_STEPS[reason] ?? "Manual investigation required.";
}

/**
 * Write an escalation for a CI run.
 *
 * Steps:
 * 1. Build human-readable summary + suggested next step
 * 2. Persist to escalations table (UNIQUE on run_id — one escalation per run)
 * 3. Chain to SOR
 * 4. Post comment on the CI run (best-effort)
 * 5. Return the EscalationRecord
 */
export async function writeEscalation(
	pool: Pool,
	opts: {
		runId: string;
		repo: string;
		externalRunId: string;
		reason: EscalationReason;
		summary: string;
		evidence?: string;
	},
): Promise<EscalationRecord> {
	const suggestedNextStep = suggestedNextStepFor(opts.reason);
	const evidence = opts.evidence ?? "See CI run logs.";

	const record: EscalationRecord = {
		run_id: opts.runId,
		reason: opts.reason,
		summary: opts.summary,
		suggested_next_step: suggestedNextStep,
		created_at: new Date().toISOString(),
	};

	// Persist to escalations table (UNIQUE on run_id)
	try {
		const result = await pool.query(
			`INSERT INTO escalations (run_id, reason, summary, suggested_next_step, created_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (run_id) DO UPDATE SET
         reason = EXCLUDED.reason,
         summary = EXCLUDED.summary,
         suggested_next_step = EXCLUDED.suggested_next_step
       RETURNING comment_url`,
			[opts.runId, opts.reason, opts.summary, suggestedNextStep],
		);
		record.comment_url = result.rows[0]?.comment_url ?? undefined;
	} catch (err) {
		console.error("[escalation] failed to persist escalation:", err);
	}

	// Chain to SOR
	await chainCiEvent(pool, opts.runId, "ci_escalation", {
		reason: opts.reason,
		summary: opts.summary,
		suggested_next_step: suggestedNextStep,
	});

	// Post comment on CI run (best-effort)
	const commentUrl = await postEscalationComment(
		opts.repo,
		opts.externalRunId,
		{
			reason: opts.reason,
			summary: opts.summary,
			suggestedNextStep,
			evidence,
		},
	);

	// Update comment_url in DB if we got one
	if (commentUrl) {
		record.comment_url = commentUrl;
		try {
			await pool.query(
				"UPDATE escalations SET comment_url = $1 WHERE run_id = $2",
				[commentUrl, opts.runId],
			);
		} catch {
			// Non-fatal
		}
	}

	console.log(`[escalation] run ${opts.runId} → reason: ${opts.reason}`);
	return record;
}
