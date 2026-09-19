// Test helpers — resolve env from process.env, falling back to a local `.env`
// file (loaded only for tests; never committed). DB-gated suites skip when no
// DATABASE_URL is available so `npm test` works in CI without a database.
// DATABASE_URL points at the SQLite database file; the schema auto-migrates
// on first open (idempotent).

import { existsSync, readFileSync } from "node:fs";
import type { Pool } from "../../src/db/pool.ts";
import { getPool } from "../../src/db/pool.ts";
import { migrateUp } from "../../src/db/migrate.ts";

export function readDotenv(key: string): string | undefined {
	if (process.env[key]) return process.env[key];
	try {
		if (existsSync(".env")) {
			for (const line of readFileSync(".env", "utf8").split("\n")) {
				const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
				if (m && m[1] === key) return m[2];
			}
		}
	} catch {
		// ignore unreadable .env
	}
	return undefined;
}

/** Inject all .env vars into process.env if not already set (once). */
let loaded = false;
export function loadDotenv(): void {
	if (loaded) return;
	loaded = true;
	try {
		if (existsSync(".env")) {
			for (const line of readFileSync(".env", "utf8").split("\n")) {
				const [key, value] = line.split("=", 2);
				if (key && !process.env[key] && value !== undefined) {
					process.env[key] = value;
				}
			}
		}
	} catch {
		// ignore unreadable .env
	}
	// Tests stay hermetic by default: never post real CI comments (network).
	if (!process.env.CI_POST_COMMENTS) process.env.CI_POST_COMMENTS = "0";
}

export const DATABASE_URL = readDotenv("DATABASE_URL");
export const SOR_SIGNING_KEY = readDotenv("SOR_SIGNING_KEY");
export const hasDb = Boolean(DATABASE_URL);

let pool: Pool | null = null;
let migrated = false;

/** Test pool — only valid when hasDb. Schema auto-migrates on first open. */
export function getTestPool(): Pool {
	if (!DATABASE_URL) {
		throw new Error("DATABASE_URL is not available; cannot open test pool");
	}
	if (!pool) {
		process.env.DATABASE_URL = DATABASE_URL;
		if (!migrated) {
			migrateUp();
			migrated = true;
		}
		pool = getPool();
	}
	return pool;
}

export async function closeTestPool(): Promise<void> {
	if (pool) {
		await pool.end();
		pool = null;
	}
}

/** Insert a minimal ci_runs row and return its run_id (for FK-bound tests). */
export async function insertCiRun(
	pool: Pool,
	overrides: Record<string, unknown> = {},
): Promise<string> {
	const result = await pool.query<{ run_id: string }>(
		`INSERT INTO ci_runs (external_run_id, repo, "commit", branch, job_id, job_name, status, log_url, created_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
		 RETURNING run_id`,
		[
			(overrides.external_run_id as string) ??
				`test-run-${Math.random().toString(36).slice(2)}`,
			(overrides.repo as string) ?? "acme/widget",
			(overrides.commit as string) ??
				"0123456789abcdef0123456789abcdef01234567",
			(overrides.branch as string) ?? "feature/test",
			(overrides.job_id as string) ?? `job-${Math.floor(Math.random() * 1e9)}`,
			(overrides.job_name as string) ?? "test (ubuntu-latest)",
			(overrides.status as string) ?? "pending",
			(overrides.log_url as string) ??
				"https://api.github.com/repos/acme/widget/actions/jobs/1",
		],
	);
	return result.rows[0]!.run_id;
}

/** Remove a ci_runs row (cascades to child tables). */
export async function removeCiRun(pool: Pool, runId: string): Promise<void> {
	await pool.query("DELETE FROM ci_runs WHERE run_id = $1", [runId]);
}