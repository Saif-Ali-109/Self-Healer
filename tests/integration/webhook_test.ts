// T016 — webhook endpoint contract: auth + response codes (quickstart A-partial + G)
// DB-gated: runs against DATABASE_URL when available, else skips.

import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { handleCiWebhook } from "../../src/webhook/server.ts";
import {
	closeTestPool,
	getTestPool,
	hasDb,
	loadDotenv,
} from "../helpers/db.ts";

loadDotenv();

const fixture = readFileSync(
	"tests/fixtures/github-workflow-job-fail.json",
	"utf8",
);

function sign(body: string): string {
	const secret = process.env.CI_WEBHOOK_SECRET ?? "";
	return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function signedHeaders(
	body = fixture,
	extra?: Record<string, string>,
): Record<string, string> {
	return {
		"x-webhook-secret": sign(body),
		"x-github-event": "workflow_job",
		...extra,
	};
}

describe.skipIf(!hasDb)("webhook contract (POST /api/webhook/ci)", () => {
	const pool = getTestPool();
	const runIds: string[] = [];

	beforeEach(async () => {
		await pool.query(
			"DELETE FROM ci_runs WHERE repo = 'acme/widget' AND external_run_id = '1234567890'",
		);
	});

	afterAll(async () => {
		for (const id of runIds) {
			await pool
				.query("DELETE FROM ci_runs WHERE run_id = $1", [id])
				.catch(() => {});
		}
		await closeTestPool();
	});

	it("accepts a valid workflow_job failed event → 202 with run_id", async () => {
		const res = await handleCiWebhook(signedHeaders(), fixture);
		expect(res.status).toBe(202);
		expect(res.body).toBeTruthy();
		const runId = (res.body as { run_id?: string }).run_id;
		expect(runId).toBeTruthy();
		if (runId) runIds.push(runId);

		const row = await pool.query(
			"SELECT status, repo, branch FROM ci_runs WHERE run_id = $1",
			[runId],
		);
		expect(row.rows[0]?.status).toBe("pending");
		expect(row.rows[0]?.repo).toBe("acme/widget");
		expect(row.rows[0]?.branch).toBe("feature/fix-lint");
	});

	it("skips events from the agent's own ci-fix/* branches → 202 skipped", async () => {
		const agentBranch = fixture.replaceAll(
			'"feature/fix-lint"',
			'"ci-fix/01234567"',
		);
		const res = await handleCiWebhook(signedHeaders(agentBranch), agentBranch);
		expect(res.status).toBe(202);
		expect(res.body).toEqual({ ok: true, skipped: "agent branch" });
		// No ci_runs row is created for the agent's own branch
		const row = await pool.query(
			"SELECT count(*)::int AS n FROM ci_runs WHERE external_run_id = '1234567890' AND branch = 'ci-fix/01234567'",
		);
		expect(row.rows[0]?.n).toBe(0);
	});

	it("rejects a duplicate event → 409", async () => {
		await handleCiWebhook(signedHeaders(), fixture);
		const res = await handleCiWebhook(signedHeaders(), fixture);
		expect(res.status).toBe(409);
	});

	it("rejects a bad secret → 401", async () => {
		const res = await handleCiWebhook(
			{ ...signedHeaders(), "x-webhook-secret": "sha256=deadbeef" },
			fixture,
		);
		expect(res.status).toBe(401);
	});

	it("rejects a missing secret → 401", async () => {
		const res = await handleCiWebhook(
			{ "x-github-event": "workflow_job" },
			fixture,
		);
		expect(res.status).toBe(401);
	});

	it("ignores non-failure events → 400", async () => {
		const success = fixture.replace(
			/"conclusion": "failure"/,
			'"conclusion": "success"',
		);
		const res = await handleCiWebhook(signedHeaders(success), success);
		expect(res.status).toBe(400);
	});

	it("rejects wrong event type header → 400", async () => {
		const res = await handleCiWebhook(
			signedHeaders(fixture, { "x-github-event": "push" }),
			fixture,
		);
		expect(res.status).toBe(400);
	});

	it("rejects invalid JSON → 400", async () => {
		const res = await handleCiWebhook(signedHeaders("{not json"), "{not json");
		expect(res.status).toBe(400);
	});
});
