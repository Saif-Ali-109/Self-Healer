// Migration runner CLI — applies and rolls back .sql migrations on the
// standalone SQLite database (migrations/ 001–022).
// Usage: npx tsx src/db/migrate.ts up|down <name|--all>
//   npm run migrate:up    → tsx src/db/migrate.ts up
//   npm run migrate:down  → tsx src/db/migrate.ts down --all

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { closeDb, getDb } from "./sqlite.ts";
import { packagePath } from "../paths.ts";

// Package-relative so migrations resolve regardless of CWD or where the
// bundled dist/ lives (global installs, daemon spawning, or repo runs).
const MIGRATIONS_DIR = packagePath("migrations");

function listMigrationFiles(): string[] {
	if (!fs.existsSync(MIGRATIONS_DIR)) return [];
	return fs
		.readdirSync(MIGRATIONS_DIR)
		.filter((f) => f.endsWith(".sql"))
		.sort();
}

function parseMigrationFile(content: string): { up: string; down: string } {
	const upMatch = content.match(/--\s*UP:\s*\n([\s\S]*?)(?=\n--\s*DOWN:|$)/i);
	const downMatch = content.match(/--\s*DOWN:\s*\n([\s\S]*?)$/i);
	return {
		up: upMatch?.[1] ? upMatch[1].trim() : "",
		down: downMatch?.[1] ? downMatch[1].trim() : "",
	};
}

function ensureMigrationsTable(db: DatabaseSync): void {
	db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      name       TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL,
      status     TEXT NOT NULL CHECK (status IN ('applied', 'rolled_back'))
    )
  `);
}

function getAppliedMigrations(db: DatabaseSync): Set<string> {
	const rows = db
		.prepare("SELECT name FROM migrations WHERE status = 'applied'")
		.all() as Array<{ name: string }>;
	return new Set(rows.map((r) => r.name));
}

/** Apply pending migrations. Idempotent; returns the number applied. */
export function migrateUp(db: DatabaseSync = getDb()): number {
	ensureMigrationsTable(db);
	const applied = getAppliedMigrations(db);
	let appliedCount = 0;
	for (const name of listMigrationFiles()) {
		if (applied.has(name)) continue;
		const { up } = parseMigrationFile(
			fs.readFileSync(path.join(MIGRATIONS_DIR, name), "utf8"),
		);
		if (!up) {
			console.warn(`[migrate] no -- UP: section in ${name}; skipping`);
			continue;
		}
		console.log(`[migrate] applying ${name}`);
		db.exec("BEGIN");
		try {
			db.exec(up);
			db.prepare(
				"INSERT INTO migrations (name, applied_at, status) VALUES (?, ?, 'applied') ON CONFLICT (name) DO UPDATE SET applied_at = excluded.applied_at, status = 'applied'",
			).run(name, Date.now());
			db.exec("COMMIT");
		} catch (err) {
			db.exec("ROLLBACK");
			throw new Error(`migration ${name} failed: ${String(err)}`);
		}
		appliedCount++;
	}
	if (appliedCount === 0) {
		console.log("[migrate] nothing to apply — all migrations already applied");
	} else {
		console.log(
			`[migrate] applied ${appliedCount} migration${
				appliedCount === 1 ? "" : "s"
			}`,
		);
	}
	return appliedCount;
}

/** Roll back applied migrations. all=true rolls back every applied migration. */
export function migrateDown(db: DatabaseSync = getDb(), all = false): void {
	ensureMigrationsTable(db);
	const rows = db
		.prepare(
			"SELECT name FROM migrations WHERE status = 'applied' ORDER BY name DESC",
		)
		.all() as Array<{ name: string }>;
	if (rows.length === 0) {
		console.log("[migrate] nothing to roll back");
		return;
	}
	for (const row of rows) {
		if (!all) continue;
		const filePath = path.join(MIGRATIONS_DIR, row.name);
		if (!fs.existsSync(filePath)) {
			console.warn(`[migrate] no migration file for ${row.name}; skipping`);
			continue;
		}
		const { down } = parseMigrationFile(fs.readFileSync(filePath, "utf8"));
		if (!down) {
			console.warn(`[migrate] no -- DOWN: section in ${row.name}; skipping`);
			continue;
		}
		console.log(`[migrate] rolling back ${row.name}`);
		db.exec("BEGIN");
		try {
			db.exec(down);
			db.prepare(
				"UPDATE migrations SET status = 'rolled_back' WHERE name = ?",
			).run(row.name);
			db.exec("COMMIT");
		} catch (err) {
			db.exec("ROLLBACK");
			throw new Error(`rollback ${row.name} failed: ${String(err)}`);
		}
	}
}

// ── CLI ───────────────────────────────────────────────────────────────

// Only when THIS file is the entry script. (A bundled CLI/daemon has
// import.meta.url === argv[1], which must not trigger the migrate CLI.)
const isDirectRun = process.argv[1]?.replace(/\\/g, "/").endsWith("src/db/migrate.ts") ?? false;

if (isDirectRun) {
	const command = process.argv[2];
	const rest = process.argv.slice(3);
	if (command === "up") {
		migrateUp();
		closeDb();
	} else if (command === "down") {
		migrateDown(getDb(), rest.includes("--all") || rest.length === 0);
		closeDb();
	} else {
		console.error(
			"Usage: npx tsx src/db/migrate.ts up|down <name|--all>\n  npm run migrate:up   → apply pending migrations\n  npm run migrate:down  → roll back migrations",
		);
		process.exit(1);
	}
}