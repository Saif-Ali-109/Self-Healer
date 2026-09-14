// T038 — SOR hash-chain integrity for CI tables (quickstart F)
// Chains events → verify ok → tamper → verify fails → restore → verify ok.

import { describe, expect, it } from "vitest";
import { runSorVerify } from "../../fleet/src/sor/verify.ts";
import { reconstructRun } from "../../src/audit/reconstruct.ts";
import { chainCiEvent } from "../../src/sor/ciEvents.ts";
import {
	getTestPool,
	hasDb,
	insertCiRun,
	loadDotenv,
	removeCiRun,
} from "../helpers/db.ts";

loadDotenv();

describe.skipIf(!hasDb || !process.env.SOR_SIGNING_KEY)(
	"SOR CI integration",
	() => {
		const pool = getTestPool();

		it("chains a classification event and verifies the hash-chain", async () => {
			const runId = await insertCiRun(pool);

			await chainCiEvent(pool, runId, "ci_classification", {
				category: "flaky",
				confidence: 0.9,
				evidence: ["timeout_pattern"],
			});

			const code = await runSorVerify(pool);
			expect(code).toBe(0);

			await removeCiRun(pool, runId);
		});

		it("detects tampering (modified payload) and recovers after restore", async () => {
			const runId = await insertCiRun(pool);

			await chainCiEvent(pool, runId, "ci_classification", {
				category: "real_bug",
				confidence: 0.9,
			});

			// The app cannot tamper via SQL (append-only trigger). Simulate an
			// external tamper: disable the trigger, modify the payload, re-enable.
			await pool.query(
				"ALTER TABLE audit_events DISABLE TRIGGER audit_events_append_only_trigger",
			);
			await pool.query(
				`UPDATE audit_events
			 SET payload = payload || '{"tampered":true}'::jsonb
			 WHERE run_id = $1 AND payload->>'kind' = 'ci_classification'`,
				[runId],
			);
			await pool.query(
				"ALTER TABLE audit_events ENABLE TRIGGER audit_events_append_only_trigger",
			);
			const badCode = await runSorVerify(pool);
			expect(badCode).toBe(1);

			// Restore the original payload (bypassing the trigger) → chain valid.
			await pool.query(
				"ALTER TABLE audit_events DISABLE TRIGGER audit_events_append_only_trigger",
			);
			await pool.query(
				`UPDATE audit_events
			 SET payload = payload - 'tampered'
			 WHERE run_id = $1 AND payload->>'kind' = 'ci_classification'`,
				[runId],
			);
			await pool.query(
				"ALTER TABLE audit_events ENABLE TRIGGER audit_events_append_only_trigger",
			);
			const okCode = await runSorVerify(pool);
			expect(okCode).toBe(0);

			await removeCiRun(pool, runId);
		});

		it("chains escalation and fix_attempt events in sequence", async () => {
			const runId = await insertCiRun(pool);

			await chainCiEvent(pool, runId, "ci_classification", {
				category: "real_bug",
				confidence: 0.9,
			});
			await chainCiEvent(pool, runId, "ci_fix_attempt", {
				pattern_matched: "lint/format",
				branch: "ci-fix/01234567",
			});

			const sor = await pool.query(
				"SELECT payload FROM audit_events WHERE run_id = $1 ORDER BY created_at ASC",
				[runId],
			);
			expect(sor.rows.length).toBe(2);
			expect(sor.rows[0]?.payload?.kind).toBe("ci_classification");
			expect(sor.rows[1]?.payload?.kind).toBe("ci_fix_attempt");

			const code = await runSorVerify(pool);
			expect(code).toBe(0);

			await removeCiRun(pool, runId);
		});
	},
);

describe.skipIf(!hasDb || !process.env.SOR_SIGNING_KEY)(
	"audit reconstruction (T039)",
	() => {
		const pool = getTestPool();

		it("reconstructs a run with classification, fix attempt, and escalation", async () => {
			const runId = await insertCiRun(pool, {
				external_run_id: "rec-test-001",
				branch: "main",
			});

			await chainCiEvent(pool, runId, "ci_classification", {
				category: "real_bug",
				confidence: 0.9,
			});
			await chainCiEvent(pool, runId, "ci_fix_attempt", {
				pattern_matched: "lint/format",
				branch: "ci-fix/abcdef12",
			});

			await pool.query(
				`INSERT INTO classifications (run_id, category, confidence, evidence, classifier_version, summary, created_at)
			 VALUES ($1, 'real_bug', 0.9, '[]', 'signals-v1', 'rule-first classification: real_bug', now())`,
				[runId],
			);
			await pool.query(
				`INSERT INTO fix_attempts (run_id, pattern_matched, diff, branch, verification_result, created_at)
			 VALUES ($1, 'lint/format', '--- a/file.ts', 'ci-fix/abcdef12', 'passed', now())`,
				[runId],
			);

			const record = await reconstructRun(pool, runId);
			expect(record.run_id).toBe(runId);
			expect(record.event.repo).toBe("acme/widget");
			expect(record.event.branch).toBe("main");
			expect(record.classifications.length).toBe(1);
			expect(record.classifications[0]?.category).toBe("real_bug");
			expect(record.fix_attempts.length).toBe(1);
			expect(record.fix_attempts[0]?.verification_result).toBe("passed");

			const md = (
				await import("../../src/audit/reconstruct.ts")
			).renderRunAuditMarkdown(record);
			expect(md).toContain("# Run audit:");
			expect(md).toContain("## Classification(s)");
			expect(md).toContain("## Fix attempt(s)");

			await removeCiRun(pool, runId);
		});

		it("reconstructRun throws for a non-existent run", async () => {
			const fake = "00000000-0000-0000-0000-000000000000";
			await expect(reconstructRun(pool, fake)).rejects.toThrow("no ci_run");
		});
	},
);
