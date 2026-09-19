// `self-healer status` — report database, pending queue, watched repos, SOR chain.

import { loadConfig } from "../config.ts";
import { getPool, closePool } from "../db/pool.ts";
import { resolveDbPath } from "../db/sqlite.ts";
import { verifyChain } from "../sor/chain.ts";

export async function cliStatus(): Promise<void> {
	let config;
	try {
		config = loadConfig();
	} catch (err) {
		console.error(`✗ configuration incomplete: ${String(err)}`);
		console.error("  Run `self-healer init` and fill in GH_TOKEN in .env first.");
		process.exit(1);
	}

	const pool = getPool();

	const tablesRow = await pool.query(
		"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
	);
	const tables = (tablesRow.rows as Array<{ name: string }>).map((r) => r.name);
	const appliedRow = await pool.query(
		"SELECT count(*) AS n FROM migrations WHERE status = 'applied'",
	);
	const applied = Number((appliedRow.rows[0] as { n: number }).n) || 0;
	const pendingRow = await pool.query(
		"SELECT count(*) AS n FROM ci_runs WHERE status = 'pending'",
	);
	const pending = Number((pendingRow.rows[0] as { n: number }).n) || 0;
	const processedRow = await pool.query(
		"SELECT count(*) AS n FROM ci_runs WHERE status NOT IN ('pending')",
	);
	const processed = Number((processedRow.rows[0] as { n: number }).n) || 0;
	const watchedRow = await pool.query(
		"SELECT repo, workflow_pr FROM watched_repos ORDER BY added_at DESC",
	);
	const watched = watchedRow.rows as Array<{
		repo: string;
		workflow_pr: string | null;
	}>;

	// SOR chain integrity.
	let sorLine: string;
	try {
		const v = await verifyChain(pool);
		sorLine = v.ok
			? `ok (${v.total} chained events)`
			: `BROKEN (first bad seq ${v.firstBadSeq})`;
	} catch (err) {
		sorLine = `unavailable: ${String(err)}`;
	}

	console.log("Self-Healer CI Agent — status");
	console.log("──────────────────────────────");
	console.log(`  database : ${resolveDbPath()}`);
	console.log(
		`  schema   : ${applied} migration(s) applied; tables: ${tables.join(", ")}`,
	);
	console.log(`  webhook  : :${config.webhookPort} (POST /api/webhook/ci)`);
	console.log(`  queue    : ${pending} pending, ${processed} processed`);
	console.log(`  SOR chain: ${sorLine}`);
	console.log(
		`  watched  : ${watched.length > 0 ? "" : "(none — run `self-healer enable --repo owner/repo`)"}`,
	);
	for (const w of watched) {
		console.log(`    - ${w.repo}${w.workflow_pr ? ` (PR ${w.workflow_pr})` : ""}`);
	}

	await closePool();
}