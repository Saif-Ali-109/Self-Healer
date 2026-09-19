// Shared database handle — single instance, lazily created.
// Backed by node:sqlite (see ./sqlite.ts); keeps the Pool-shaped surface the
// pipeline uses so call sites only change their type import.

import type { Db, QueryResult, SqlRow } from "./sqlite.ts";
import { closeDb, query as runQuery } from "./sqlite.ts";

export type Pool = Db;
export type { QueryResult };

let pool: Pool | null = null;

export function getPool(): Pool {
	if (pool) return pool;
	pool = {
		query<T = SqlRow>(
			text: string,
			params: readonly unknown[] = [],
		): Promise<QueryResult<T>> {
			return runQuery<T>(text, params);
		},
		async end(): Promise<void> {
			closeDb();
		},
	};
	return pool;
}

export async function closePool(): Promise<void> {
	closeDb();
	pool = null;
}