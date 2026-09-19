// SQLite database layer (constitution v1.3.0 — node:sqlite, zero extra deps).
// Keeps the async Pool-style `query()` surface the pipeline already uses:
//   $N placeholders  → ?
//   now()            → (unixepoch() * 1000)   [Unix ms INTEGER columns]
//   FOR UPDATE SKIP LOCKED → dropped (single FIFO worker, no row locking)

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface SqlRow {
	[column: string]: unknown;
}

export interface QueryResult<T = SqlRow> {
	rows: T[];
	rowCount: number;
}

/** The minimal async query surface the pipeline depends on (pg-Pool-shaped). */
export interface Db {
	query<T = SqlRow>(
		text: string,
		params?: readonly unknown[],
	): Promise<QueryResult<T>>;
	end(): Promise<void>;
}

let db: DatabaseSync | null = null;

/** Resolve DATABASE_URL (a file path, optionally sqlite:-prefixed) to a path. */
export function resolveDbPath(): string {
	const raw = (process.env.DATABASE_URL ?? "").trim();
	if (raw === "") return "./data/self-healer.db";
	const p = raw.replace(/^sqlite:\/+/, "").replace(/^sqlite:/, "");
	return p === "" ? "./data/self-healer.db" : p;
}

export function getDb(): DatabaseSync {
	if (db) return db;
	const p = resolveDbPath();
	if (p !== ":memory:") {
		mkdirSync(dirname(resolve(p)), { recursive: true });
	}
	db = new DatabaseSync(p);
	db.exec("PRAGMA foreign_keys = ON;");
	db.exec("PRAGMA journal_mode = WAL;");
	return db;
}

export function closeDb(): void {
	db?.close();
	db = null;
}

/** Adapt Postgres-flavored SQL to SQLite for the wrapper's callers. */
export function rewriteSql(text: string): string {
	return text
		.replace(/\$(\d+)/g, "?")
		.replace(/\s+FOR\s+UPDATE\s+SKIP\s+LOCKED/gi, "")
		.replace(/\bnow\(\)/gi, "(unixepoch() * 1000)")
		.trim();
}

const SELECTISH = /^\s*(SELECT|WITH|EXPLAIN)\b/i;

function isSelectLike(sql: string): boolean {
	return SELECTISH.test(sql) || /\bRETURNING\b/i.test(sql);
}

/** Async-compatible query against the SQLite database (single statement). */
export async function query<T = SqlRow>(
	text: string,
	params: readonly unknown[] = [],
): Promise<QueryResult<T>> {
	const sql = rewriteSql(text);
	const stmt = getDb().prepare(sql);
	if (isSelectLike(sql)) {
		const rows =
			params.length > 0 ? stmt.all(...(params as never[])) : stmt.all();
		return { rows: rows as T[], rowCount: rows.length };
	}
	const info =
		params.length > 0 ? stmt.run(...(params as never[])) : stmt.run();
	return { rows: [], rowCount: Number(info.changes) };
}