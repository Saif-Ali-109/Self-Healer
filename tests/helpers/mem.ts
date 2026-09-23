// Hermetic in-memory SQLite for agent tests (no .env / DATABASE_URL needed).
import type { Pool } from "../../src/db/pool.ts";

export async function memPool(): Promise<Pool> {
	const prevDb = process.env.DATABASE_URL;
	process.env.DATABASE_URL = ":memory:";
	process.env.SOR_SIGNING_KEY = "test-signing-key-for-agent-tests-0123456789";
	process.env.CI_POST_COMMENTS = "0";
	const { migrateUp } = await import("../../src/db/migrate.ts");
	const { getPool } = await import("../../src/db/pool.ts");
	migrateUp(); // opens (and caches) the in-memory handle for this test file
	// Do not leak :memory: into other test files sharing the forked process.
	if (prevDb === undefined) delete process.env.DATABASE_URL;
	else process.env.DATABASE_URL = prevDb;
	return getPool();
}
