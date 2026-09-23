// Re-fix loop: lineage, escalation cap, provider errors — via the real orchestrator.
import { describe, expect, it } from "vitest";
import {
	processCiFailure,
	resolveLineage,
} from "../../src/pipeline/orchestrator.ts";
import { memPool } from "../helpers/mem.ts";

const pool = await memPool();
for (const k of [
	"GEMINI_API_KEY",
	"OPENROUTER_API_KEY",
	"OLLAMA_BASE_URL",
	"SELF_HEALER_LLM_PROVIDER",
	"SELF_HEALER_CONFIG",
])
	delete process.env[k];

const ev = (branch: string, ext: string) => ({
	repo: "acme/calc",
	commit: "a".repeat(40),
	branch,
	external_run_id: ext,
	job_id: `j${ext}`,
	job_name: "test",
	status: "failed" as const,
	log_url: "https://api.github.com/repos/acme/calc/actions/jobs/1",
	delivered_at: new Date().toISOString(),
});

async function seedParent(branch: string, cycle: number): Promise<string> {
	const id = (
		await pool.query<{ run_id: string }>(
			`INSERT INTO ci_runs (external_run_id, repo, "commit", branch, job_id, status, fix_branch, fix_cycle, created_at)
		 VALUES ($1,'acme/calc',$2,'feature/x',$3,'resolved',$4,$5, now()) RETURNING run_id`,
			[
				`p${Math.random()}`,
				"b".repeat(40),
				`pj${Math.random()}`,
				branch,
				cycle,
			],
		)
	).rows[0]!.run_id;
	return id;
}

describe("re-fix loop", () => {
	it("a failure on a pushed ci-fix branch becomes the parent's next cycle", async () => {
		const parent = await seedParent("ci-fix/lin00001", 0);
		expect(
			await resolveLineage(pool, ev("ci-fix/lin00001", "1")),
		).toMatchObject({
			cycle: 1,
			parentRunId: parent,
			branch: "ci-fix/lin00001",
		});
		expect(await resolveLineage(pool, ev("feature/x", "2"))).toMatchObject({
			cycle: 0,
			branch: null,
		});
	});

	it("escalates retry_cap_exceeded instead of looping forever (default cap 3)", async () => {
		await seedParent("ci-fix/cap00001", 3); // parent already at cycle 3 → this one is cycle 4
		const r = await processCiFailure(ev("ci-fix/cap00001", "cap1"));
		expect(r).toMatchObject({
			path: "escalated",
			reason: "retry_cap_exceeded",
		});
		const row = (
			await pool.query<{ fix_cycle: number; parent_run_id: string }>(
				"SELECT fix_cycle, parent_run_id FROM ci_runs WHERE run_id=$1",
				[r.runId],
			)
		).rows[0];
		expect(row?.fix_cycle).toBe(4);
		expect(row?.parent_run_id).toBeTruthy();
	});

	it("a cycle within the cap proceeds to the brain (here: no provider → llm_unavailable)", async () => {
		await seedParent("ci-fix/cap00002", 2); // this failure = cycle 3 = allowed
		const r = await processCiFailure(ev("ci-fix/cap00002", "cap2"));
		expect(r).toMatchObject({ path: "escalated", reason: "llm_unavailable" });
	});

	it("penalizes notes from the failed parent fix", async () => {
		const parent = await seedParent("ci-fix/pen00001", 0);
		await pool.query(
			`INSERT INTO repo_notes (repo, kind, body, source_run_id, created_at) VALUES ('acme/calc','fix_recipe','use plus',$1, now())`,
			[parent],
		);
		await processCiFailure(ev("ci-fix/pen00001", "pen1"));
		const c = (
			await pool.query<{ confidence: number }>(
				"SELECT confidence FROM repo_notes WHERE source_run_id=$1",
				[parent],
			)
		).rows[0]?.confidence;
		expect(Number(c)).toBeLessThan(0.6);
	});

	it("never touches protected branches", async () => {
		const r = await processCiFailure(ev("main", "m1"));
		expect(r).toMatchObject({ path: "escalated", reason: "critical_branch" });
	});
});
