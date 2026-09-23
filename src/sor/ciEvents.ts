import type { Pool } from "../db/pool.ts";
import { appendAuditEvent, ensureChain } from "./chain.ts";
import { redactSecrets } from "../pipeline/comments.ts";
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

// ── Agent reasoning trace ────────────────────────────────────────────
// Every model turn, tool call, gate result, and decision is chained into the
// same tamper-evident log as the outcome events, so an operator can replay
// WHY the agent did what it did (not just what happened).

export type AgentEventKind =
	| "ci_agent_start" // provider/model choice, limits, lineage
	| "ci_agent_reasoning" // model's stated rationale for a turn
	| "ci_agent_tool" // a tool call + truncated output
	| "ci_agent_gate" // full-suite verification result
	| "ci_agent_decision" // finish / give_up with rationale
	| "ci_notes_read" // notes injected into the prompt
	| "ci_notes_written"; // notes stored after the run

const AUDIT_STR_MAX = 4000;

/** Redact secrets and cap string length before anything reaches the audit log. */
export function sanitizeForAudit(value: unknown): unknown {
	if (typeof value === "string") {
		const red = redactSecrets(value);
		return red.length > AUDIT_STR_MAX
			? `${red.slice(0, AUDIT_STR_MAX)}…[+${red.length - AUDIT_STR_MAX} chars]`
			: red;
	}
	if (Array.isArray(value)) return value.slice(0, 50).map(sanitizeForAudit);
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>))
			out[k] = sanitizeForAudit(v);
		return out;
	}
	return value;
}

/** Chain an agent trace event. NON-FATAL like every other audit write. */
export async function chainAgentEvent(
	pool: Pool,
	runId: string,
	kind: AgentEventKind,
	payload: Record<string, unknown>,
	tool?: { name: string; input?: unknown; output?: unknown },
): Promise<void> {
	await ensureSorChain(pool);
	const event: SorEvent = {
		run_id: runId,
		event_type: "phase",
		actor: ACTOR,
		backend: typeof payload.provider === "string" ? payload.provider : null,
		tool_name: tool?.name ?? null,
		tool_input: tool?.input === undefined ? null : sanitizeForAudit(tool.input),
		tool_output: tool?.output === undefined ? null : sanitizeForAudit(tool.output),
		payload: { kind, ...(sanitizeForAudit(payload) as Record<string, unknown>) },
		created_at: new Date().toISOString(),
	};
	try {
		await appendAuditEvent(pool, event);
	} catch (err) {
		console.warn(`[sor] chainAgentEvent(${kind}) failed (non-fatal):`, err);
	}
}
