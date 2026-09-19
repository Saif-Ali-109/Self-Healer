// Canonical SOR event shape — self-contained (the chain no longer imports
// Fleet's event types). CI events use event_type 'phase'; the payload carries
// the kind (classification / fix_attempt / escalation / transition).

export interface SorEvent {
	run_id: string | null;
	event_type: string;
	actor: string;
	backend: string | null;
	tool_name: string | null;
	tool_input: unknown | null;
	tool_output: unknown | null;
	payload: Record<string, unknown>;
	created_at: string; // ISO 8601
}

/** Plain column object for DB inserts/verification (columns, not hash fields). */
export function eventToRecord(e: SorEvent): Record<string, unknown> {
	return {
		run_id: e.run_id,
		event_type: e.event_type,
		actor: e.actor,
		backend: e.backend,
		tool_name: e.tool_name,
		tool_input: e.tool_input,
		tool_output: e.tool_output,
		payload: e.payload,
		created_at: e.created_at,
	};
}