// Shared PostgreSQL pool — single instance, lazily created.

import type { Pool } from "pg";
import pg from "pg";

const { Pool: PgPool } = pg;

let pool: Pool | null = null;

export function getPool(): Pool {
	if (pool) return pool;
	const connectionString = process.env.DATABASE_URL;
	if (!connectionString) {
		throw new Error(
			"DATABASE_URL is not set. Configure it in .env or export it before running.",
		);
	}
	pool = new PgPool({ connectionString });
	return pool;
}

export async function closePool(): Promise<void> {
	if (!pool) return;
	await pool.end();
	pool = null;
}
