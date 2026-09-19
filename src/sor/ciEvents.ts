import type { Pool } from "../db/pool.ts";
import { appendAuditEvent, ensureChain } from "./chain.ts";
import type { SorEvent } from "./events.ts";

const ACTOR = "self-healer";

let chainEnsured = false;

async function ensureSorChain(pool: Pool): Promise<void> {
	if (chainEnsured) return;
	try {
		await ensureChain(pool);
		chainEnsured = true;
	} catch (err) {
		console.warn("[sor] ensureChain failed (non-fatal):", err);
	}
}

/**
 * Chain a CI event into the SOR hash-chain (SQLite).
 * Kind maps to payload.kind for reconstruction; event_type is always "phase".
 * NON-FATAL: failures warn and continue — never abort a pipeline over audit.
 */
export async function chainCiEvent(
	pool: Pool,
	runId: string,
	kind:
		| "ci_run_transition"
		| "ci_classification"
		| "ci_fix_attempt"
		| "ci_escalation",
	payload: Record<string, unknown>,
): Promise<void> {
	await ensureSorChain(pool);
	const event: SorEvent = {
		run_id: runId,
		event_type: "phase",
		actor: ACTOR,
		backend: null,
		tool_name: null,
		tool_input: null,
		tool_output: null,
		payload: { kind, ...payload },
		created_at: new Date().toISOString(),
	};
	try {
		await appendAuditEvent(pool, event);
	} catch (err) {
		console.warn(`[sor] chainCiEvent(${kind}) failed (non-fatal):`, err);
	}
}

/**
 * Convenience: chain a ci_runs status transition.
 */
export async function chainRunTransition(
	pool: Pool,
	runId: string,
	from: string,
	to: string,
	meta?: Record<string, unknown>,
): Promise<void> {
	await chainCiEvent(pool, runId, "ci_run_transition", { from, to, ...meta });
}