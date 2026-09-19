// Record a constitution amendment in the SOR hash-chain, per the governance
// rule: "Every constitution change MUST be recorded in the SOR log (what
// changed, when, why)."
// Usage: npx tsx --env-file-if-exists=.env scripts/record-constitution-amendment.ts

import { closePool, getPool } from "../src/db/pool.ts";
import { appendAuditEvent, ensureChain } from "../src/sor/chain.ts";
import type { SorEvent } from "../src/sor/events.ts";

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
		version: "1.2.0 -> 1.3.0",
		what: [
			"MAJOR: dropped the Fleet clone and PostgreSQL entirely.",
			"Self-Healer is now a standalone Node.js daemon: node:sqlite (built into Node 22+) for persistence, direct `git worktree` shell calls for isolated fixes, and the SOR hash chain lives in SQLite.",
			"Added §Packaging Roadmap: independent npm package (self-healer-ci-agent) with init / start / enable / status commands.",
			".specify/ + specs (spec.md, plan.md, data-model.md, quickstart.md, contracts) updated to the standalone architecture; AGENTS.md created.",
		].join(" "),
		when: new Date().toISOString(),
		why: "Explicitly approved by the project owner: ship as a zero-dependency standalone package. No Fleet clone, no PostgreSQL server required.",
	},
	created_at: new Date().toISOString(),
};

try {
	await ensureChain(pool);
	await appendAuditEvent(pool, event);
	console.log("[constitution] amendment recorded in SOR log (v1.2.0 → v1.3.0)");
} finally {
	await closePool();
}