// Record a constitution amendment in the SOR hash-chain, per the governance
// rule: "Every constitution change MUST be recorded in the SOR log (what
// changed, when, why)."
// Usage: npx tsx --env-file-if-exists=.env scripts/record-constitution-amendment.ts

import { appendAuditEvent, ensureChain } from "../fleet/src/db/audit.ts";
import type { SorEvent } from "../fleet/src/sor/events.ts";
import { closePool, getPool } from "../src/db/pool.ts";

const pool = getPool();

const event: SorEvent = {
	run_id: null,
	event_type: "phase",
	actor: "system",
	backend: null,
	tool_name: null,
	tool_input: null,
	tool_output: null,
	payload: {
		kind: "constitution_amendment",
		version: "1.1.0 -> 1.2.0",
		what: [
			"Principle V (Human-Approved Delivery) expanded: for a VERIFIED auto-fix, the agent MAY open a single fix-only pull request (ci-fix/<run-id> → failing branch) so a human can review/approve it via normal PR flow, and reference that PR in the CI run comment.",
			"The agent still NEVER merges and never pushes to protected branches.",
			"Delivery & Escalation gained a Fix delivery rule.",
			"Contracts updated: fix-attempt.md rule 5, ci-comment.md type 1 + delivery rules.",
			"Migration 022: fix_attempts.fix_pr_url.",
		].join(" "),
		when: new Date().toISOString(),
		why: "Explicitly approved by the project owner for the live demo: a fix should reach an approval step (GitHub PR review) before being applied. The human clicks approve + merge; the agent opens the PR and never merges.",
	},
	created_at: new Date().toISOString(),
};

try {
	await ensureChain(pool);
	await appendAuditEvent(pool, event);
	console.log("[constitution] amendment recorded in SOR log (v1.1.0 → v1.2.0)");
} finally {
	await closePool();
}