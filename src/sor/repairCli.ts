// CLI for `npm run sor:repair` — re-sign every audit event + the chain tail
// under the current SOR_SIGNING_KEY (key-loss recovery only). Never run this
// to paper over tampering: the old chain hashes stop verifying on purpose.

import { getDb } from "../db/sqlite.ts";
import type { SorEvent } from "./events.ts";
import { eventToRecord } from "./events.ts";
import { canonicalJson, computeHash, GENESIS_HASH } from "./signer.ts";
import { getCurrentKey, getCurrentKeyId } from "./chain.ts";

interface AuditRow {
	run_id: string | null;
	seq: number;
	event_type: string;
	actor: string;
	backend: string | null;
	tool_name: string | null;
	tool_input: string | null;
	tool_output: string | null;
	payload: string;
	prev_hash: string;
	hash: string;
	key_id: string;
	created_at: number;
}

function jsonParse(v: string | null): unknown {
	if (v === null || v === undefined) return null;
	try {
		return JSON.parse(v);
	} catch {
		return null;
	}
}

const db = getDb();
const currentKeyId = getCurrentKeyId();
const key = getCurrentKey();

const rows = db
	.prepare(
		`SELECT run_id, seq, event_type, actor, backend, tool_name,
		        tool_input, tool_output, payload, prev_hash, hash, key_id, created_at
		 FROM audit_events ORDER BY seq ASC`,
	)
	.all() as unknown as AuditRow[];

let prevHash = GENESIS_HASH;
for (const row of rows) {
	const event: SorEvent = {
		run_id: row.run_id,
		event_type: row.event_type,
		actor: row.actor,
		backend: row.backend,
		tool_name: row.tool_name,
		tool_input: jsonParse(row.tool_input),
		tool_output: jsonParse(row.tool_output),
		payload: (jsonParse(row.payload) ?? {}) as Record<string, unknown>,
		created_at: new Date(Number(row.created_at)).toISOString(),
	};
	const hash = computeHash(
		key,
		prevHash,
		canonicalJson({ ...eventToRecord(event), key_id: currentKeyId }),
	);
	db.prepare(
		"UPDATE audit_events SET prev_hash = ?, hash = ?, key_id = ? WHERE seq = ?",
	).run(prevHash, hash, currentKeyId, row.seq);
	prevHash = hash;
}

db.prepare(
	"UPDATE sor_chain SET seq = ?, hash = ?, key_id = ? WHERE id = 1",
).run(rows.length, prevHash, currentKeyId);

console.log(
	`[sor:repair] re-signed ${rows.length} audit event(s) under key ${currentKeyId}`,
);
db.close();