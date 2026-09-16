// Canonical shapes and hard limits shared across the pipeline.
// Sources of truth: contracts/webhook-ci.md, contracts/classification.md,
// contracts/fix-attempt.md, contracts/ci-comment.md, data-model.md.

// ── Categories & statuses ────────────────────────────────────────────

export type CiCategory = "flaky" | "real_bug" | "infra";

export type CiRunStatus =
	| "pending"
	| "classifying"
	| "retrying"
	| "fixing"
	| "escalated"
	| "resolved"
	| "skipped";

export type EscalationReason =
	| "low_confidence"
	| "fix_failed"
	| "multi_file"
	| "critical_branch"
	| "budget_exhausted"
	| "no_pattern_match"
	| "infra"
	| "flaky_retries_exhausted"
	| "checkout_failed";

export type FixVerificationResult = "passed" | "failed";

// ── Canonical normalized CI event (contracts/webhook-ci.md) ──────────

export interface CiEvent {
	repo: string; // owner/name
	commit: string; // full 40-char sha
	branch: string;
	external_run_id: string; // CI platform run id
	job_id: string;
	job_name: string;
	status: "failed"; // only intake status
	log_url: string;
	artifact_url?: string;
	delivered_at: string; // ISO 8601
}

export function ciDedupeKey(ev: CiEvent): string {
	return `${ev.external_run_id}:${ev.repo}:${ev.job_id}`;
}

// ── Classification result (contracts/classification.md) ──────────────

export interface ClassificationResult {
	run_id: string;
	category: CiCategory;
	confidence: number;
	evidence: Array<{ signal: string; detail: string }>;
	classifier_version: string;
	model?: string;
	summary?: string;
	decided_at: string;
}

// ── Fix attempt record (contracts/fix-attempt.md) ────────────────────

export interface FixAttemptRecord {
	run_id: string;
	pattern_matched: string;
	diff: string;
	branch: string;
	verification_result: FixVerificationResult;
	test_summary?: string;
	comment_url?: string;
	attempted_at: string;
}

// ── Escalation record (data-model.md) ───────────────────────────────

export interface EscalationRecord {
	run_id: string;
	reason: EscalationReason;
	summary: string;
	suggested_next_step: string;
	comment_url?: string;
	created_at: string;
}

// ── Hard limits (constitution) ───────────────────────────────────────

export const FIX_CONFIDENCE_THRESHOLD = 0.7;
export const MAX_RERUNS = 3;
export const MAX_LLM_CALLS = 3;
export const PIPELINE_BUDGET_MS = 10 * 60_000;
export const MULTI_FILE_THRESHOLD = 5;
export const CLASSIFIER_VERSION = "signals-v1";

const CRITICAL_BRANCH_PATTERNS: ReadonlyArray<RegExp> = [
	/^main$/,
	/^release\//,
	/^v/,
];

export function isCriticalBranch(branch: string): boolean {
	return CRITICAL_BRANCH_PATTERNS.some((re) => re.test(branch));
}
