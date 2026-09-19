// Self-Healer CI Agent — daemon entry point.
// Starts the webhook listener + single-worker queue processor.
// Usage: npm start
// Env:   see .env.example (GH_TOKEN, CI_WEBHOOK_SECRET, DATABASE_URL, SOR_SIGNING_KEY)

import { loadConfig } from "./config.ts";
import type { Pool } from "./db/pool.ts";
import { closePool, getPool } from "./db/pool.ts";
import { processCiFailure } from "./pipeline/orchestrator.ts";
import { CiQueue } from "./pipeline/queue.ts";
import type { CiEvent } from "./types.ts";
import { startWebhookServer } from "./webhook/server.ts";

const POLL_INTERVAL_MS = 2_000; // how often to check for pending ci_runs

// ── Start ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	const config = loadConfig();
	console.log("▶ Self-Healer CI Agent starting...");

	// Verify DB connection
	const pool = getPool();
	try {
		const result = await pool.query("SELECT NOW() as now");
		console.log(`▶ Database connected (${result.rows[0]?.now})`);
	} catch (err) {
		console.error("✗ Database connection failed:", err);
		process.exit(1);
	}

	// Start webhook server
	const server = await startWebhookServer(config.webhookPort);

	// Start the single-worker queue processor
	console.log("▶ Worker started — polling for pending CI failures");
	void pollLoop(pool);

	// Graceful shutdown
	const shutdown = async (): Promise<void> => {
		console.log("\n▶ Shutting down...");
		server?.close();
		await closePool();
		process.exit(0);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}

// ── Worker: single-threaded FIFO poll loop ────────────────────────────

async function pollLoop(pool: Pool): Promise<void> {
	const queue = new CiQueue(pool);
	while (true) {
		try {
			// Fetch next pending ci_run (FIFO by created_at)
			const result = await pool.query<{
				run_id: string;
				external_run_id: string;
				repo: string;
				commit: string;
				branch: string;
				job_id: string;
				job_name: string;
				log_url: string;
				artifact_url: string | null;
			}>(
				`SELECT run_id, external_run_id, repo, "commit", branch, job_id, job_name, log_url, artifact_url
				 FROM ci_runs
				 WHERE status = 'pending'
				 ORDER BY created_at ASC
				 LIMIT 1
				 FOR UPDATE SKIP LOCKED`,
			);

			const row = result.rows[0];
			if (!row) {
				await sleep(POLL_INTERVAL_MS);
				continue;
			}
			console.log(
				`[worker] processing run ${row.run_id} (${row.repo}#${row.external_run_id})`,
			);

			const event: CiEvent = {
				repo: row.repo,
				commit: row.commit,
				branch: row.branch,
				external_run_id: row.external_run_id,
				job_id: row.job_id,
				job_name: row.job_name,
				status: "failed",
				log_url: row.log_url,
				artifact_url: row.artifact_url ?? undefined,
				delivered_at: new Date().toISOString(),
			};

			// Processing-time dedup: one handling cycle per (run, job name).
			// Rows that were enqueued before the dedup existed (storm backlog)
			// or that raced it are skipped, never re-processed.
			if (await queue.isHandledDuplicate(event, row.run_id)) {
				await queue.markSkipped(row.run_id, "duplicate_re_fire");
				console.log(
					`[worker] run ${row.run_id} → skipped (duplicate re-fire: ${row.job_name} already queued/handled for run ${row.external_run_id})`,
				);
				continue;
			}

			const result2 = await processCiFailure(event, {
				runId: row.run_id,
			});
			console.log(
				`[worker] run ${row.run_id} → ${result2.path}${result2.reason ? ` (${result2.reason})` : ""}`,
			);
		} catch (err) {
			console.error("[worker] poll loop error:", err);
			await sleep(POLL_INTERVAL_MS);
		}
	}
}

const sleep = (ms: number): Promise<void> =>
	new Promise((r) => setTimeout(r, ms));

main().catch((err) => {
	console.error("Fatal:", err);
	process.exit(1);
});
