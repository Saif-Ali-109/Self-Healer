// End-to-end agent test against a REAL local git remote and a scripted fake
// model (no network): investigate → fix → full-suite gate → push to ci-fix/*.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { attemptAgentFix, type AgentFixArgs } from "../../src/agent/fixer.ts";
import { DEFAULT_AGENT_LIMITS } from "../../src/settings.ts";
import type {
	ChatRequest,
	ChatResponse,
	LlmClient,
	ToolCall,
} from "../../src/llm/types.ts";
import { PipelineBudget } from "../../src/utils/budget.ts";
import { memPool } from "../helpers/mem.ts";

const pool = await memPool();
const sh = (cwd: string, ...a: string[]): string =>
	execFileSync("git", a, { cwd, encoding: "utf8" }).trim();

function makeRemote(withTests = true): { url: string; sha: string } {
	const base = mkdtempSync(join(tmpdir(), "sh-e2e-"));
	const bare = join(base, "origin.git");
	const work = join(base, "work");
	execFileSync("git", ["init", "--bare", "-b", "main", bare]);
	execFileSync("git", ["clone", bare, work], { stdio: "ignore" });
	sh(work, "config", "user.email", "t@t");
	sh(work, "config", "user.name", "t");
	writeFileSync(
		join(work, "package.json"),
		JSON.stringify({
			name: "x",
			scripts: withTests ? { test: "node test.js" } : {},
		}),
	);
	writeFileSync(join(work, "lib.js"), "exports.add = (a, b) => a - b;\n");
	writeFileSync(
		join(work, "test.js"),
		"const {add}=require('./lib');\nif (add(2,3)!==5) { console.error('FAIL add(2,3) expected 5 got '+add(2,3)); process.exit(1); }\nconsole.log('ok');\n",
	);
	writeFileSync(join(work, ".gitignore"), "node_modules\n");
	sh(work, "add", "-A");
	sh(work, "commit", "-m", "init");
	sh(work, "push", "origin", "HEAD:refs/heads/main");
	return { url: bare, sha: sh(work, "rev-parse", "HEAD") };
}

/** A scripted "model": each step returns text + tool calls; sees prior tool results. */
function scripted(
	steps: Array<
		(seen: string[]) => { text?: string; calls: Array<Omit<ToolCall, "id">> }
	>,
): LlmClient & { turns: number } {
	const c = {
		provider: "ollama" as const,
		model: "fake",
		turns: 0,
		async chat(req: ChatRequest): Promise<ChatResponse> {
			const seen = req.messages
				.filter((m) => m.role === "tool")
				.map((m) => m.content);
			const step = steps[Math.min(c.turns, steps.length - 1)];
			c.turns++;
			const r = step ? step(seen) : { calls: [] };
			return {
				text: r.text ?? "",
				toolCalls: r.calls.map((x, i) => ({ id: `c${c.turns}_${i}`, ...x })),
			};
		},
	};
	return c;
}

async function setup(
	o: { withTests?: boolean } = {},
): Promise<{
	args: Omit<AgentFixArgs, "llm">;
	sha: string;
	url: string;
	runId: string;
}> {
	const { url, sha } = makeRemote(o.withTests ?? true);
	const runId = (
		await pool.query<{ run_id: string }>(
			`INSERT INTO ci_runs (external_run_id, repo, "commit", branch, job_id, job_name, status, log_url, created_at)
		 VALUES ($1,'acme/calc',$2,'feature/x',$3,'test','fixing','u', now()) RETURNING run_id`,
			[`e${Math.random()}`, sha, `j${Math.random()}`],
		)
	).rows[0]!.run_id;
	return {
		url,
		sha,
		runId,
		args: {
			pool,
			runId,
			event: {
				repo: "acme/calc",
				commit: sha,
				branch: "feature/x",
				external_run_id: "1",
				job_id: "1",
				job_name: "test",
				status: "failed",
				log_url: "u",
				delivered_at: new Date().toISOString(),
			},
			classification: {
				run_id: runId,
				category: "real_bug",
				confidence: 0.9,
				evidence: [],
				classifier_version: "t",
				decided_at: "",
			},
			logText: "FAIL add(2,3) expected 5 got -1",
			budget: new PipelineBudget(new Date(), 40, 120_000),
			limits: {
				...DEFAULT_AGENT_LIMITS,
				commandTimeoutMs: 30_000,
				gateTimeoutMs: 60_000,
			},
			repoCfg: { installCommand: "" },
			branch: `ci-fix/${runId.slice(0, 8)}`,
			cycle: 0,
			runsRoot: mkdtempSync(join(tmpdir(), "sh-runs-")),
			cacheDir: mkdtempSync(join(tmpdir(), "sh-cache-")),
			repoUrl: url,
			skipComment: true,
		},
	};
}

const FIX = { path: "lib.js", old_str: "a - b", new_str: "a + b" };
const FINISH = (
	confidence = 0.9,
	extra: Record<string, unknown> = {},
): { name: string; args: Record<string, unknown> } => ({
	name: "finish",
	args: {
		root_cause: "add() subtracts instead of adds",
		summary: "use + in add()",
		rationale: "log shows add(2,3) = -1; lib.js used '-'",
		confidence,
		notes: [
			{
				kind: "test_info",
				text: "Tests run with plain `node test.js` via npm test.",
				tags: ["npm"],
			},
		],
		...extra,
	},
});

describe("agent fix pipeline (real git, scripted model)", () => {
	it("diagnoses, fixes, passes the full suite, and pushes ONLY to ci-fix/*", async () => {
		const s = await setup();
		const llm = scripted([
			() => ({
				text: "Log points at add(); reading lib.js.",
				calls: [{ name: "read_file", args: { path: "lib.js" } }],
			}),
			() => ({
				text: "Operator is wrong.",
				calls: [{ name: "edit_file", args: FIX }],
			}),
			() => ({
				text: "Verify locally.",
				calls: [{ name: "run_command", args: { command: "npm test" } }],
			}),
			() => ({ text: "Done.", calls: [FINISH()] }),
		]);
		const r = await attemptAgentFix({ ...s.args, llm });
		expect(r.kind).toBe("delivered");
		// skipComment → no outbound GitHub calls: no comment, no fix PR.
		expect(r).toMatchObject({ commentUrl: null, fixPrUrl: null });
		// remote: fix branch exists with the fix commit; main untouched
		expect(sh(s.url, "show", `${s.args.branch}:lib.js`)).toContain("a + b");
		expect(sh(s.url, "rev-parse", "main")).toBe(s.sha);
		expect(sh(s.url, "log", "-1", "--format=%an %s", s.args.branch)).toContain(
			"fix(ci)",
		);
		// bookkeeping
		const fa = await pool.query<{
			verification_result: string;
			root_cause: string;
			branch: string;
		}>("SELECT * FROM fix_attempts WHERE run_id = $1", [s.runId]);
		expect(fa.rows[0]).toMatchObject({
			verification_result: "passed",
			branch: s.args.branch,
		});
		expect(fa.rows[0]?.root_cause).toContain("subtracts");
		expect(
			(
				await pool.query("SELECT fix_branch FROM ci_runs WHERE run_id=$1", [
					s.runId,
				])
			).rows[0],
		).toMatchObject({ fix_branch: s.args.branch });
		// reasoning trace is in the SOR chain
		const ev = await pool.query<{ payload: string }>(
			"SELECT payload FROM audit_events WHERE run_id=$1 ORDER BY seq",
			[s.runId],
		);
		const kinds = ev.rows.map(
			(e) => (JSON.parse(e.payload) as { kind: string }).kind,
		);
		expect(kinds).toContain("ci_agent_start");
		expect(kinds).toContain("ci_agent_reasoning");
		expect(kinds).toContain("ci_agent_gate");
		expect(kinds).toContain("ci_agent_decision");
		expect(ev.rows.some((e) => e.payload.includes("Operator is wrong"))).toBe(
			true,
		);
		// notes written
		expect(
			(await pool.query("SELECT 1 FROM repo_notes WHERE repo='acme/calc'"))
				.rowCount,
		).toBeGreaterThan(0);
	});

	it("rejects an explicit skip marker via guardrail, then accepts a real fix", async () => {
		const s = await setup();
		let sawRejection = false;
		const llm = scripted([
			() => ({
				calls: [
					{
						name: "write_file",
						args: {
							path: "skipme.test.js",
							content: "it.skip('x', () => {})\n",
						},
					},
				],
			}),
			() => ({ calls: [FINISH()] }),
			(seen) => {
				sawRejection = seen.some((x) => /skip/i.test(x) && /rejected/.test(x));
				return { calls: [{ name: "edit_file", args: FIX }] };
			},
			() => ({ calls: [FINISH()] }),
		]);
		const r = await attemptAgentFix({ ...s.args, llm });
		expect(sawRejection).toBe(true);
		// the leftover skip file is still in the tree → guardrail keeps rejecting → escalates, never pushes
		expect(r.kind).toBe("escalate");
		expect(
			(
				await pool.query(
					"SELECT 1 FROM ci_runs WHERE run_id=$1 AND fix_branch IS NOT NULL",
					[s.runId],
				)
			).rowCount,
		).toBe(0);
		expect(() => sh(s.url, "rev-parse", s.args.branch)).toThrow();
	});

	it("an empty diff is refused every time → escalates, nothing pushed", async () => {
		const s = await setup();
		const llm = scripted([
			() => ({ calls: [FINISH()] }), // nothing changed yet → guardrail (no changes)
			() => ({ calls: [FINISH()] }),
			() => ({ calls: [FINISH()] }),
		]);
		const r = await attemptAgentFix({ ...s.args, llm });
		expect(r.kind).toBe("escalate");
		expect(() => sh(s.url, "rev-parse", s.args.branch)).toThrow();
	});

	it("gate failure output is returned to the model, which then fixes and succeeds", async () => {
		const s = await setup();
		let gateFeedback = "";
		const llm = scripted([
			() => ({
				calls: [
					{
						name: "edit_file",
						args: { path: "lib.js", old_str: "a - b", new_str: "a * b" },
					},
				],
			}), // wrong fix
			() => ({ calls: [FINISH()] }),
			(seen) => {
				gateFeedback = seen.join("\n");
				return {
					calls: [
						{
							name: "edit_file",
							args: { path: "lib.js", old_str: "a * b", new_str: "a + b" },
						},
					],
				};
			},
			() => ({ calls: [FINISH()] }),
		]);
		const r = await attemptAgentFix({ ...s.args, llm });
		expect(gateFeedback).toMatch(/FULL SUITE FAILED/);
		expect(gateFeedback).toMatch(/expected 5/);
		expect(r.kind).toBe("delivered");
		expect(sh(s.url, "show", `${s.args.branch}:lib.js`)).toContain("a + b");
	});

	it("give_up escalates as agent_gave_up and stores a note; nothing pushed", async () => {
		const s = await setup();
		const llm = scripted([
			() => ({
				calls: [
					{
						name: "give_up",
						args: {
							reason: "needs prod credentials",
							rationale: "tried X and Y",
							notes: [
								{
									kind: "gotcha",
									text: "Integration suite requires PROD_DB secret unavailable in CI worktrees.",
								},
							],
						},
					},
				],
			}),
		]);
		const r = await attemptAgentFix({ ...s.args, llm });
		expect(r).toMatchObject({ kind: "escalate", reason: "agent_gave_up" });
		expect(
			(
				await pool.query(
					"SELECT 1 FROM repo_notes WHERE repo='acme/calc' AND body LIKE '%PROD_DB%'",
				)
			).rowCount,
		).toBe(1);
		expect(() => sh(s.url, "rev-parse", s.args.branch)).toThrow();
	});

	it("low self-reported confidence is not pushed", async () => {
		const s = await setup();
		const llm = scripted([
			() => ({ calls: [{ name: "edit_file", args: FIX }] }),
			() => ({ calls: [FINISH(0.4)] }),
		]);
		expect(await attemptAgentFix({ ...s.args, llm })).toMatchObject({
			kind: "escalate",
			reason: "low_confidence",
		});
		expect(() => sh(s.url, "rev-parse", s.args.branch)).toThrow();
	});

	it("model-call budget exhaustion escalates budget_exhausted", async () => {
		const s = await setup();
		const llm = scripted([() => ({ calls: [{ name: "list_dir", args: {} }] })]);
		const r = await attemptAgentFix({
			...s.args,
			llm,
			budget: new PipelineBudget(new Date(), 3, 60_000),
		});
		expect(r).toMatchObject({ kind: "escalate", reason: "budget_exhausted" });
	});

	it("no detectable test command → refuses before spending any model calls", async () => {
		const s = await setup({ withTests: false });
		const llm = scripted([() => ({ calls: [FINISH()] })]);
		expect(await attemptAgentFix({ ...s.args, llm })).toMatchObject({
			kind: "escalate",
			reason: "no_test_command",
		});
		expect(llm.turns).toBe(0);
	});

	it("a model that errors → llm_unavailable", async () => {
		const s = await setup();
		const llm: LlmClient = {
			provider: "gemini",
			model: "m",
			chat: async () => {
				throw new Error("boom");
			},
		};
		expect(await attemptAgentFix({ ...s.args, llm })).toMatchObject({
			kind: "escalate",
			reason: "llm_unavailable",
		});
	});
});
