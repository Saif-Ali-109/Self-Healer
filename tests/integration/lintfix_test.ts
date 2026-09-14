// T029 — fix-scope DB behavior: one-attempt cap on fix_attempts (quickstart B)

import { afterAll, describe, expect, it } from "vitest";
import { recordFixAttempt } from "../../src/pipeline/fixscope/record.ts";
import {
	closeTestPool,
	getTestPool,
	hasDb,
	insertCiRun,
	loadDotenv,
	removeCiRun,
} from "../helpers/db.ts";

loadDotenv();

describe.skipIf(!hasDb)("fix attempt persistence (one-attempt cap)", () => {
	const pool = getTestPool();
	const runIds: string[] = [];

	afterAll(async () => {
		for (const id of runIds) await removeCiRun(pool, id).catch(() => {});
		await closeTestPool();
	});

	it("records exactly one fix attempt per run even if called twice", async () => {
		const runId = await insertCiRun(pool);
		runIds.push(runId);

		await recordFixAttempt(pool, {
			runId,
			patternMatched: "lint/format",
			diff: "--- a/src/a.ts\n+++ b/src/a.ts",
			branch: "ci-fix/01234567",
			verificationResult: "passed",
			testSummary: "biome check --write: 1 file fixed, exit 0",
		});

		// A second call must not create a second row (unique on run_id).
		await recordFixAttempt(pool, {
			runId,
			patternMatched: "lint/format",
			diff: "--- a/src/a.ts\n+++ b/src/a.ts",
			branch: "ci-fix/01234567",
			verificationResult: "failed", // same run would never re-attempt
			testSummary: "second call should not duplicate",
		});

		const rows = await pool.query(
			"SELECT * FROM fix_attempts WHERE run_id = $1",
			[runId],
		);
		expect(rows.rows.length).toBe(1);
		expect(rows.rows[0]?.pattern_matched).toBe("lint/format");
		expect(rows.rows[0]?.branch).toBe("ci-fix/01234567");
	});

	it("chains the fix attempt into SOR audit events", async () => {
		const runId = await insertCiRun(pool);
		runIds.push(runId);

		await recordFixAttempt(pool, {
			runId,
			patternMatched: "lint/format",
			diff: "--- a/src/b.ts\n+++ b/src/b.ts",
			branch: "ci-fix/01234568",
			verificationResult: "passed",
		});

		const sor = await pool.query(
			`SELECT payload FROM audit_events WHERE run_id = $1 AND payload->>'kind' = 'ci_fix_attempt'`,
			[runId],
		);
		expect(sor.rows.length).toBeGreaterThanOrEqual(1);
		expect(sor.rows[0]?.payload?.pattern_matched).toBe("lint/format");
	});
});
