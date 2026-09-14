// Migration runner CLI — applies and rolls back .sql migrations.
// Scans BOTH the local `fleet/migrations` clone (001–016) and this repo's
// own `migrations/` (017–020) on the same PostgreSQL database, applying
// unapplied files in filename order.
// Usage: npx tsx src/db/migrate.ts up|down <name|--all>
//   npm run migrate:up    → tsx src/db/migrate.ts up
//   npm run migrate:down  → tsx src/db/migrate.ts down --all

import fs from "node:fs";
import path from "node:path";
import type { Pool as PoolType, QueryResult } from "pg";
import pg from "pg";

const { Pool } = pg;

interface MigrationRecord {
	id: number;
	name: string;
	applied_at: Date;
	status: string;
}

function getPool(): PoolType {
	const databaseUrl = process.env.DATABASE_URL;
	if (!databaseUrl) {
		throw new Error(
			"DATABASE_URL is not set. Configure it in .env or export it before running migrations.",
		);
	}
	return new Pool({ connectionString: databaseUrl });
}

/** Migration source dirs: fleet clone first, then Self-Healer's own. */
function getMigrationsDirs(): string[] {
	const dirs = [
		path.resolve(process.cwd(), "fleet", "migrations"),
		path.resolve(process.cwd(), "migrations"),
	];
	return dirs.filter((d) => fs.existsSync(d));
}

function parseMigrationFile(filePath: string): { up: string; down: string } {
	const content = fs.readFileSync(filePath, "utf-8");

	const upMatch = content.match(/--\s*UP:\s*\n([\s\S]*?)(?=\n--\s*DOWN:|$)/i);
	const downMatch = content.match(/--\s*DOWN:\s*\n([\s\S]*?)$/i);

	const up = upMatch?.[1] ? upMatch[1].trim() : "";
	const down = downMatch?.[1] ? downMatch[1].trim() : "";

	return { up, down };
}

function listMigrationFiles(): string[] {
	const seen = new Set<string>();
	const files: string[] = [];
	for (const dir of getMigrationsDirs()) {
		for (const f of fs
			.readdirSync(dir)
			.filter((f) => f.endsWith(".sql"))
			.sort()) {
			if (!seen.has(f)) {
				seen.add(f);
				files.push(path.join(dir, f));
			}
		}
	}
	return files.sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
}

async function ensureMigrationsTable(pool: PoolType): Promise<void> {
	await pool.query(`
    CREATE TABLE IF NOT EXISTS migrations (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMP NOT NULL DEFAULT now(),
      status TEXT NOT NULL CHECK (status IN ('applied', 'rolled_back'))
    )
  `);
}

async function getAppliedMigrations(pool: PoolType): Promise<string[]> {
	const result: QueryResult<{ name: string }> = await pool.query(
		"SELECT name FROM migrations WHERE status = 'applied' ORDER BY name ASC",
	);
	return result.rows.map((row) => row.name);
}

async function up(): Promise<void> {
	const pool = getPool();
	try {
		await ensureMigrationsTable(pool);
		const applied = new Set(await getAppliedMigrations(pool));
		const files = listMigrationFiles();
		let appliedCount = 0;
		for (const filePath of files) {
			const name = path.basename(filePath);
			if (applied.has(name)) continue;
			const { up: upSql } = parseMigrationFile(filePath);
			if (!upSql) {
				console.warn(`[migrate] no -- UP: section in ${name}; skipping`);
				continue;
			}
			console.log(`[migrate] applying ${name} (${filePath})`);
			await pool.query("BEGIN");
			try {
				await pool.query(upSql);
				await pool.query(
					"INSERT INTO migrations (name, status) VALUES ($1, 'applied')",
					[name],
				);
				await pool.query("COMMIT");
			} catch (err) {
				await pool.query("ROLLBACK");
				throw new Error(`migration ${name} failed: ${String(err)}`);
			}
			appliedCount++;
		}
		console.log(
			appliedCount === 0
				? "[migrate] nothing to apply — all migrations already applied"
				: `[migrate] applied ${appliedCount} migration${appliedCount === 1 ? "" : "s"}`,
		);
	} finally {
		await pool.end();
	}
}

async function down(): Promise<void> {
	const pool = getPool();
	try {
		await ensureMigrationsTable(pool);
		const args = process.argv.slice(3);
		const all = args.includes("--all") || args.length === 0;
		const result: QueryResult<MigrationRecord> = await pool.query(
			"SELECT id, name, applied_at, status FROM migrations WHERE status = 'applied' ORDER BY name DESC",
		);
		const appliedRows = result.rows;
		if (appliedRows.length === 0) {
			console.log("[migrate] nothing to roll back");
			return;
		}
		for (const row of appliedRows) {
			if (!all && !args.includes(row.name)) continue;
			const filePath = listMigrationFiles().find(
				(f) => path.basename(f) === row.name,
			);
			if (!filePath) {
				console.warn(`[migrate] no migration file for ${row.name}; skipping`);
				continue;
			}
			const { down: downSql } = parseMigrationFile(filePath);
			if (!downSql) {
				console.warn(`[migrate] no -- DOWN: section in ${row.name}; skipping`);
				continue;
			}
			console.log(`[migrate] rolling back ${row.name}`);
			await pool.query("BEGIN");
			try {
				await pool.query(downSql);
				await pool.query(
					"UPDATE migrations SET status = 'rolled_back' WHERE name = $1",
					[row.name],
				);
				await pool.query("COMMIT");
			} catch (err) {
				await pool.query("ROLLBACK");
				throw new Error(`rollback ${row.name} failed: ${String(err)}`);
			}
		}
	} finally {
		await pool.end();
	}
}

const command = process.argv[2];
if (command === "up") {
	await up();
} else if (command === "down") {
	await down();
} else {
	console.error(
		"Usage: npx tsx src/db/migrate.ts up|down <name|--all>\n  npm run migrate:up   → apply pending migrations\n  npm run migrate:down  → roll back migrations",
	);
	process.exit(1);
}
