// T035 — escalation path persistence + SOR (quickstart C/D)

import { afterAll, describe, expect, it } from "vitest";
import { writeEscalation } from "../../src/pipeline/escalation/writer.ts";
import {
	closeTestPool,
	getTestPool,
	hasDb,
	insertCiRun,
	loadDotenv,
	removeCiRun,
} from "../helpers/db.ts";

loadDotenv();

describe.skipIf(!hasDb)("escalation writer", () => {
	const pool = getTestPool();
	const runIds: string[] = [];

	afterAll(async () => {
		for (const id of runIds) await removeCiRun(pool, id).catch(() => {});
		await closeTestPool();
	});

	it("persists an escalation row with reason + next step", async () => {
		const runId = await insertCiRun(pool);
		runIds.push(runId);

		const record = await writeEscalation(pool, {
			runId,
			repo: "acme/widget",
			externalRunId: "1234567890",
			reason: "multi_file",
			summary: "Failure touches 7 files; manual triage required.",
			evidence: "diff-stat shows 7 files",
		});

		expect(record.reason).toBe("multi_file");
		expect(record.suggested_next_step).toMatch(/5\+ files/i);

		const rows = await pool.query(
			"SELECT * FROM escalations WHERE run_id = $1",
			[runId],
		);
		expect(rows.rows.length).toBe(1);
		expect(rows.rows[0]?.reason).toBe("multi_file");
	});

	it("chains the escalation into SOR audit events", async () => {
		const runId = await insertCiRun(pool);
		runIds.push(runId);

		await writeEscalation(pool, {
			runId,
			repo: "acme/widget",
			externalRunId: "1234567891",
			reason: "critical_branch",
			summary: "Failure on main branch; manual review required.",
		});

		const sor = await pool.query<{ payload: string }>(
			`SELECT payload FROM audit_events WHERE run_id = $1 AND payload LIKE '%ci_escalation%'`,
			[runId],
		);
		expect(sor.rows.length).toBeGreaterThanOrEqual(1);
		const payload = JSON.parse(sor.rows[0]!.payload) as { reason?: string };
		expect(payload.reason).toBe("critical_branch");
	});

	it("upserts on repeated escalation for the same run (one row)", async () => {
		const runId = await insertCiRun(pool);
		runIds.push(runId);

		await writeEscalation(pool, {
			runId,
			repo: "acme/widget",
			externalRunId: "1234567892",
			reason: "infra",
			summary: "Docker pull failed",
		});
		await writeEscalation(pool, {
			runId,
			repo: "acme/widget",
			externalRunId: "1234567892",
			reason: "infra",
			summary: "Disk full on runner",
		});

		const rows = await pool.query(
			"SELECT * FROM escalations WHERE run_id = $1",
			[runId],
		);
		expect(rows.rows.length).toBe(1);
		expect(rows.rows[0]?.summary).toBe("Disk full on runner");
	});
});
