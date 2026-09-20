// CLI DB-side effects + status rendering (US6): `registerWatched` watched_repos
// upsert and `self-healer status` output. DB-gated: runs against DATABASE_URL
// when available, else skips (same pattern as webhook/sor/importfix/lintfix).
// Hermetic: uses dummy env values for the required-vars check, restores after.

import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { registerWatched } from "../../src/cli/enable.ts";
import { cliStatus } from "../../src/cli/status.ts";
import type { Pool } from "../../src/db/pool.ts";
import {
	closeTestPool,
	getTestPool,
	hasDb,
	insertCiRun,
	loadDotenv,
	removeCiRun,
} from "../helpers/db.ts";

loadDotenv();

const TEST_REPO = "acme/cli-demo";
const TEST_REPO_2 = "acme/cli-demo-2";
const PR_URL = "https://github.com/acme/cli-demo/pull/9";

/** Capture + restore specific env keys so the tests stay hermetic. */
const SAVED_ENV = new Map<string, string | undefined>();
function saveEnv(...keys: string[]): void {
	for (const k of keys) SAVED_ENV.set(k, process.env[k]);
}
function restoreEnv(): void {
	for (const [k, v] of SAVED_ENV) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
}

async function watchedRows(
	pool: Pool,
	repo: string,
): Promise<
	Array<{ repo: string; workflow_branch: string; workflow_pr: string | null }>
> {
	const r = await pool.query(
		"SELECT repo, workflow_branch, workflow_pr FROM watched_repos WHERE repo = $1",
		[repo],
	);
	return r.rows as Array<{
		repo: string;
		workflow_branch: string;
		workflow_pr: string | null;
	}>;
}

describe.skipIf(!hasDb)("registerWatched watched_repos upsert", () => {
	const pool = getTestPool();

	beforeEach(async () => {
		await pool.query("DELETE FROM watched_repos WHERE repo IN ($1, $2)", [
			TEST_REPO,
			TEST_REPO_2,
		]);
	});

	afterAll(async () => {
		await pool.query("DELETE FROM watched_repos WHERE repo IN ($1, $2)", [
			TEST_REPO,
			TEST_REPO_2,
		]);
		await closeTestPool();
	});

	it("inserts a new watched repo with branch + PR url", async () => {
		await registerWatched(TEST_REPO, "self-healer/enable", PR_URL, pool);
		const rows = await watchedRows(pool, TEST_REPO);
		expect(rows).toHaveLength(1);
		const [row] = rows;
		expect(row).toBeDefined();
		expect(row?.workflow_branch).toBe("self-healer/enable");
		expect(row?.workflow_pr).toBe(PR_URL);
	});

	it("upserts on conflict (re-enable keeps a single row with the new values)", async () => {
		await registerWatched(TEST_REPO, "self-healer/enable", "pr-1", pool);
		await registerWatched(TEST_REPO, "main", "pr-2", pool);
		const rows = await watchedRows(pool, TEST_REPO);
		expect(rows).toHaveLength(1);
		const [row] = rows;
		expect(row).toBeDefined();
		expect(row?.workflow_branch).toBe("main");
		expect(row?.workflow_pr).toBe("pr-2");
	});

	it("records a null PR when the reporter already exists", async () => {
		await registerWatched(TEST_REPO_2, "main", null, pool);
		const rows = await watchedRows(pool, TEST_REPO_2);
		expect(rows).toHaveLength(1);
		const [row] = rows;
		expect(row).toBeDefined();
		expect(row?.workflow_branch).toBe("main");
		expect(row?.workflow_pr).toBeNull();
	});
});

describe.skipIf(!hasDb)("self-healer status output", () => {
	const pool = getTestPool();
	let runId: string | null = null;

	beforeEach(async () => {
		saveEnv("GH_TOKEN", "CI_WEBHOOK_SECRET", "CI_WEBHOOK_PORT", "DATABASE_URL");
		// loadConfig only checks presence; the values are never used for network.
		process.env.GH_TOKEN = "ghp_cli_status_dummy";
		process.env.CI_WEBHOOK_SECRET = "cli-status-dummy-secret";
		process.env.CI_WEBHOOK_PORT = "3457";
		await pool.query("DELETE FROM watched_repos WHERE repo = $1", [TEST_REPO]);
		runId = await insertCiRun(pool, {
			repo: TEST_REPO,
			branch: "feature/cli",
			status: "pending",
			job_name: "lint (ubuntu-latest)",
		});
		await registerWatched(TEST_REPO, "self-healer/enable", PR_URL, pool);
	});

	afterEach(async () => {
		if (runId) await removeCiRun(pool, runId).catch(() => {});
		runId = null;
		await pool.query("DELETE FROM watched_repos WHERE repo = $1", [TEST_REPO]);
	});

	afterAll(async () => {
		restoreEnv();
		await closeTestPool();
	});

	it("renders db, webhook, queue, SOR and watched lines", async () => {
		const lines: string[] = [];
		const spy = vi
			.spyOn(console, "log")
			.mockImplementation((...parts: unknown[]) => {
				lines.push(parts.map(String).join(" "));
			});
		try {
			await cliStatus();
		} finally {
			spy.mockRestore();
		}
		const text = lines.join("\n");
		expect(text).toContain("Self-Healer CI Agent — status");
		expect(text).toContain("database :");
		expect(text).toContain("schema   :");
		expect(text).toContain("webhook  : :3457 (POST /api/webhook/ci)");
		expect(text).toMatch(/queue\s*:\s*\d+ pending, \d+ processed/);
		expect(text).toMatch(/SOR chain: ok/);
		expect(text).toContain(`- acme/cli-demo (PR ${PR_URL})`);
	});
});
