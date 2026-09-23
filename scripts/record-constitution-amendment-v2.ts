// Record the v1.3.0 -> v2.0.0 constitution amendment in the SOR hash-chain.
// Usage: npm run sor:amend:v2
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
		version: "1.3.0 -> 2.0.0",
		what: "MAJOR: II (allowlist + single attempt) replaced by AI-agent fixes for any CI failure with a bounded re-fix loop (default 3 cycles); V (fix PR) replaced by push-to-ci-fix-branch + CI comment only (never PR, never merge); LLM cap raised from 3 to configurable per-run budgets; memory: reasoning trace in SOR + per-repo notes; providers Gemini/OpenRouter/Ollama selectable globally and per repo.",
		when: new Date().toISOString(),
		why: "Explicitly requested by the project owner (upgrade spec).",
	},
	created_at: new Date().toISOString(),
});
await closePool();
console.log("✓ constitution amendment v2.0.0 recorded");
