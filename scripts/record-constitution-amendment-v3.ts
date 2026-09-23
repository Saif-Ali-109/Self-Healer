// Record the v2.0.0 -> v3.0.0 constitution amendment in the SOR hash-chain.
// Usage: npm run sor:amend:v3
import { closePool, getPool } from "../src/db/pool.ts";
import { appendAuditEvent, ensureChain } from "../src/sor/chain.ts";

const pool = getPool();
await ensureChain(pool);
await appendAuditEvent(pool, {
	run_id: null,
	event_type: "phase",
	actor: "system",
	backend: null,
	tool_name: null,
	tool_input: null,
	tool_output: null,
	payload: {
		kind: "constitution_amendment",
		version: "2.0.0 -> 3.0.0",
		what: "MAJOR: principle V (Human-Approved Delivery) redefined — a verified fix is still pushed to ci-fix/<run-id> with a CI comment, but MAY now additionally be surfaced as a best-effort fix-only pull request from ci-fix/<run-id> to the failing branch for human review. PR opening is best-effort: on failure (network, cross-fork commit, permissions, head equals base) delivery falls back to branch + comment and never blocks the fix. The agent still NEVER merges and NEVER touches protected branches.",
		when: new Date().toISOString(),
		why: "Explicitly requested by the project owner: fixes should be submitted as pull requests for review, with branch + comment fallback.",
	},
	created_at: new Date().toISOString(),
});
await closePool();
console.log("✓ constitution amendment v3.0.0 recorded");