// SOR audit chain — append-only tamper-evident log inside SQLite.
// Every event is HMAC-SHA256'd onto the previous event's hash; verifying
// replays the chain and recomputes each hash (npm run sor:verify).

import { randomUUID } from "node:crypto";
import type { Pool, QueryResult } from "../db/pool.ts";
import { getDb } from "../db/sqlite.ts";
import type { SorEvent } from "./events.ts";
import { eventToRecord } from "./events.ts";
import { canonicalJson, computeHash, GENESIS_HASH } from "./signer.ts";

export { GENESIS_HASH };

// ── Key registry (env-driven; SOR_KEY_ID selects the active key) ───────

export function getCurrentKeyId(): string {
	return process.env.SOR_KEY_ID ?? "v1";
}

export function getKey(keyId: string): string | undefined {
	const normalized = keyId.toUpperCase().replace(/[^A-Z0-9]/g, "_");
	const envVar = `SOR_KEY_${normalized}`;
	return (
		process.env[envVar] ??
		(normalized === "V1" ? process.env.SOR_SIGNING_KEY : undefined)
	);
}

export function getCurrentKey(): string {
	const keyId = getCurrentKeyId();
	const key = getKey(keyId);
	if (key === undefined) {
		throw new Error(
			`SOR_SIGNING_KEY is not set. Configure it in .env or export it before appending/verifying audit events.`,
		);
	}
	return key;
}

// ── Schema (belt-and-braces; migration 017 also creates these) ─────────

function ensureTables(): void {
	const db = getDb();
	db.exec(`
    CREATE TABLE IF NOT EXISTS sor_chain (
      id     INTEGER PRIMARY KEY CHECK (id = 1),
      seq    INTEGER NOT NULL DEFAULT 0,
      hash   TEXT NOT NULL,
      key_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit_events (
      event_id    TEXT PRIMARY KEY,
      run_id      TEXT,
      seq         INTEGER NOT NULL UNIQUE,
      event_type  TEXT NOT NULL,
      actor       TEXT NOT NULL,
      backend     TEXT,
      tool_name   TEXT,
      tool_input  TEXT,
      tool_output TEXT,
      payload     TEXT NOT NULL,
      prev_hash   TEXT NOT NULL,
      hash        TEXT NOT NULL,
      key_id      TEXT NOT NULL,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_events_run ON audit_events (run_id);
  `);
	// Seed the genesis row under the current key id (idempotent).
	db.prepare(
		"INSERT OR IGNORE INTO sor_chain (id, seq, hash, key_id) VALUES (1, 0, ?, ?)",
	).run(GENESIS_HASH, getCurrentKeyId());
}

/** Idempotent: ensure the chain tables + genesis row exist. NON-FATAL upstream. */
export async function ensureChain(_pool: Pool): Promise<void> {
	ensureTables();
}

function jsonOrNull(v: unknown): string | null {
	if (v === undefined || v === null) return null;
	return JSON.stringify(v);
}

function jsonParse(v: string | null): unknown {
	if (v === null || v === undefined) return null;
	try {
		return JSON.parse(v);
	} catch {
		return null;
	}
}

/** Canonical created_at shared by append + verify: ms-resolution ISO string. */
function canonicalCreatedAt(createdAtMs: number): string {
	return new Date(createdAtMs).toISOString();
}

interface ChainTail {
	seq: number;
	hash: string;
}

/**
 * Append one event to the chain. Transactional: signs against the current
 * tail, inserts the row, advances the tail. NON-FATAL at the call sites —
 * a pipeline never aborts over audit.
 */
export async function appendAuditEvent(
	pool: Pool,
	event: SorEvent,
): Promise<void> {
	ensureTables();
	const db = getDb();
	const keyId = getCurrentKeyId();
	const key = getCurrentKey();

	const tail = db
		.prepare("SELECT seq, hash FROM sor_chain WHERE id = 1")
		.get() as ChainTail | undefined;
	if (!tail) {
		throw new Error(
			"sor_chain (id=1) missing — call ensureChain() before appending audit events",
		);
	}

	const nextSeq = Number(tail.seq) + 1;
	const createdAtMs = Date.parse(event.created_at) || Date.now();
	const hash = computeHash(
		key,
		tail.hash,
		canonicalJson({
			run_id: event.run_id,
			event_type: event.event_type,
			actor: event.actor,
			backend: event.backend,
			tool_name: event.tool_name,
			tool_input: event.tool_input,
			tool_output: event.tool_output,
			payload: event.payload,
			created_at: canonicalCreatedAt(createdAtMs),
			key_id: keyId,
		}),
	);

	db.exec("BEGIN");
	try {
		db.prepare(
			`INSERT INTO audit_events
        (event_id, run_id, seq, event_type, actor, backend, tool_name, tool_input, tool_output, payload, prev_hash, hash, key_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			randomUUID(),
			event.run_id,
			nextSeq,
			event.event_type,
			event.actor,
			event.backend,
			jsonOrNull(event.tool_name),
			jsonOrNull(event.tool_input),
			jsonOrNull(event.tool_output),
			jsonOrNull(event.payload),
			tail.hash,
			hash,
			keyId,
			createdAtMs,
		);
		db.prepare(
			"UPDATE sor_chain SET seq = ?, hash = ?, key_id = ? WHERE id = 1",
		).run(nextSeq, hash, keyId);
		db.exec("COMMIT");
	} catch (err) {
		db.exec("ROLLBACK");
		throw err;
	}
}

// ── Verification ──────────────────────────────────────────────────────

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

export interface VerifyResult {
	ok: boolean;
	firstBadSeq: number | null;
	total: number;
	counts: Record<string, number>;
}

/** Replay verification: recompute each hash from prev_hash + row + key.
 *  Any mismatch (tampering or reordered rows) fails at the first bad seq. */
export async function verifyChain(pool: Pool): Promise<VerifyResult> {
	const db = getDb();
	const rows = db
		.prepare(
			`SELECT run_id, seq, event_type, actor, backend, tool_name,
			        tool_input, tool_output, payload, prev_hash, hash, key_id, created_at
			 FROM audit_events
			 ORDER BY seq ASC`,
		)
		.all() as unknown as AuditRow[];

	const counts: Record<string, number> = {};
	let prevHash = GENESIS_HASH;
	let firstBadSeq: number | null = null;

	for (const row of rows) {
		counts[row.event_type] = (counts[row.event_type] ?? 0) + 1;
		if (firstBadSeq !== null) continue; // already failed; keep tallying

		if (row.prev_hash !== prevHash) {
			firstBadSeq = Number(row.seq);
			continue;
		}
		const key = getKey(row.key_id);
		if (!key) {
			firstBadSeq = Number(row.seq);
			continue;
		}
		const event: SorEvent = {
			run_id: row.run_id,
			event_type: row.event_type,
			actor: row.actor,
			backend: row.backend,
			tool_name: row.tool_name,
			tool_input: jsonParse(row.tool_input),
			tool_output: jsonParse(row.tool_output),
			payload: (jsonParse(row.payload) ?? {}) as Record<string, unknown>,
			created_at: canonicalCreatedAt(Number(row.created_at)),
		};
		const recomputed = computeHash(
			key,
			row.prev_hash,
			canonicalJson({ ...eventToRecord(event), key_id: row.key_id }),
		);
		if (recomputed !== row.hash) {
			firstBadSeq = Number(row.seq);
			continue;
		}
		prevHash = row.hash;
	}

	return { ok: firstBadSeq === null, firstBadSeq, total: rows.length, counts };
}

// Re-exported so a single import covers tests that want a QueryResult type.
export type { QueryResult };