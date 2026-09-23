// Audit reconstruction (T039) — rebuild what the agent saw and decided for a
// CI run from the four Self-Healer tables (ci_runs / classifications /
// fix_attempts / escalations). Operators can read a run's full history from
// the database without guessing, and cross-check it against the SOR hash-chain.
//
// CLI: npx tsx src/audit/reconstruct.ts <run-id>
//   (reads DATABASE_URL + SOR settings from .env via tsx --env-file-if-exists)

import type { Pool } from "../db/pool.ts";
import { getPool } from "../db/pool.ts";

// SQLite stores timestamps as INTEGER unix ms; rows surface them as numbers.
export interface RunAuditRecord {
	run_id: string;
	event: {
		external_run_id: string;
		repo: string;
		commit: string;
		branch: string;
		job_id: string;
		job_name: string | null;
		status: string;
		log_url: string | null;
		artifact_url: string | null;
		created_at: number;
		completed_at: number | null;
	};
	classifications: Array<{
		classification_id: string;
		category: string;
		confidence: string | number;
		evidence: unknown;
		classifier_version: string;
		model: string | null;
		summary: string | null;
		created_at: number;
	}>;
	fix_attempts: Array<{
		attempt_id: string;
		pattern_matched: string;
		diff: string;
		branch: string;
		verification_result: string;
		test_summary: string | null;
		comment_url: string | null;
		fix_pr_url: string | null;
		created_at: number;
	}>;
	escalations: Array<{
		escalation_id: string;
		reason: string;
		summary: string;
		suggested_next_step: string;
		comment_url: string | null;
		created_at: number;
	}>;
	/** The agent's reasoning trace: model turns, tool calls, gate results, decisions (SOR chain). */
	agent_trace: AgentTraceEntry[];
}

export interface AgentTraceEntry {
	seq: number;
	kind: string;
	tool_name: string | null;
	payload: Record<string, unknown>;
	tool_input: unknown;
	tool_output: unknown;
	created_at: number;
}

/** Reconstruct the audit record for one run. Throws if the run does not exist. */
export async function reconstructRun(
	pool: Pool,
	runId: string,
): Promise<RunAuditRecord> {
	const runResult = await pool.query<RunAuditRecord["event"]>(
		`SELECT external_run_id, repo, "commit", branch, job_id, job_name, status,
		        log_url, artifact_url, created_at, completed_at
		 FROM ci_runs WHERE run_id = $1`,
		[runId],
	);
	const event = runResult.rows[0];
	if (!event) {
		throw new Error(`no ci_run with run_id ${runId}`);
	}

	const [classifications, fixAttempts, escalations, trace] = await Promise.all([
		pool.query<RunAuditRecord["classifications"][number]>(
			`SELECT classification_id, category, confidence, evidence, classifier_version, model, summary, created_at
			 FROM classifications WHERE run_id = $1 ORDER BY created_at ASC`,
			[runId],
		),
		pool.query<RunAuditRecord["fix_attempts"][number]>(
			`SELECT attempt_id, pattern_matched, diff, branch, verification_result, test_summary, comment_url, fix_pr_url, created_at
			 FROM fix_attempts WHERE run_id = $1 ORDER BY created_at ASC`,
			[runId],
		),
		pool.query<RunAuditRecord["escalations"][number]>(
			`SELECT escalation_id, reason, summary, suggested_next_step, comment_url, created_at
			 FROM escalations WHERE run_id = $1 ORDER BY created_at ASC`,
			[runId],
		),
		pool.query<{
			seq: number;
			tool_name: string | null;
			tool_input: string | null;
			tool_output: string | null;
			payload: string;
			created_at: number;
		}>(
			`SELECT seq, tool_name, tool_input, tool_output, payload, created_at
			 FROM audit_events WHERE run_id = $1 ORDER BY seq ASC`,
			[runId],
		),
	]);

	const parse = (t: string | null): unknown => {
		if (t === null || t === undefined) return null;
		try {
			return JSON.parse(t);
		} catch {
			return t;
		}
	};
	const agentTrace: AgentTraceEntry[] = [];
	for (const r of trace.rows) {
		const payload = (parse(r.payload) ?? {}) as Record<string, unknown>;
		const kind = String(payload.kind ?? "");
		if (!kind.startsWith("ci_agent_") && !kind.startsWith("ci_notes_")) continue;
		agentTrace.push({
			seq: Number(r.seq),
			kind,
			tool_name: r.tool_name,
			payload,
			tool_input: parse(r.tool_input),
			tool_output: parse(r.tool_output),
			created_at: Number(r.created_at),
		});
	}

	return {
		run_id: runId,
		event,
		classifications: classifications.rows,
		fix_attempts: fixAttempts.rows,
		escalations: escalations.rows,
		agent_trace: agentTrace,
	};
}

/** Render the audit record as human-readable markdown for an operator. */
export function renderRunAuditMarkdown(record: RunAuditRecord): string {
	const lines: string[] = [
		`# Run audit: ${record.run_id}`,
		"",
		"## Event (what the agent saw)",
		`- repo: \`${record.event.repo}\``,
		`- commit: \`${record.event.commit}\``,
		`- branch: \`${record.event.branch}\``,
		`- external run: \`${record.event.external_run_id}\``,
		`- job: \`${record.event.job_id}\` (${record.event.job_name ?? "unnamed"})`,
		`- status transitioned to: \`${record.event.status}\``,
		`- logs: ${record.event.log_url ?? "(none)"}`,
		"",
	];

	if (record.classifications.length > 0) {
		lines.push("## Classification(s)");
		for (const c of record.classifications) {
			lines.push(
				`- **${c.category}** confidence ${c.confidence} (${c.classifier_version}, ${c.model ?? "rules-only"}) at ${new Date(c.created_at).toISOString()}`,
			);
			if (c.summary) lines.push(`  - summary: ${c.summary}`);
		}
		lines.push("");
	}

	if (record.fix_attempts.length > 0) {
		lines.push("## Fix attempt(s)");
		for (const f of record.fix_attempts) {
			lines.push(
				`- pattern \`${f.pattern_matched}\` on \`${f.branch}\` → **${f.verification_result}** at ${new Date(f.created_at).toISOString()}`,
			);
			if (f.comment_url) lines.push(`  - comment: ${f.comment_url}`);
			if (f.fix_pr_url)
				lines.push(`  - fix PR: ${f.fix_pr_url} (human review; never auto-merged)`);
		}
		lines.push("");
	}

	if (record.escalations.length > 0) {
		lines.push("## Escalation(s)");
		for (const e of record.escalations) {
			lines.push(`- reason \`${e.reason}\` at ${new Date(e.created_at).toISOString()}`);
			lines.push(`  - summary: ${e.summary}`);
			lines.push(`  - next step: ${e.suggested_next_step}`);
			if (e.comment_url) lines.push(`  - comment: ${e.comment_url}`);
		}
		lines.push("");
	}

	if (record.agent_trace.length > 0) {
		lines.push("## Agent reasoning trace");
		const clip = (v: unknown, n: number): string => {
			const t = typeof v === "string" ? v : JSON.stringify(v);
			return (t ?? "").replace(/\s+/g, " ").slice(0, n);
		};
		for (const t of record.agent_trace) {
			const at = new Date(t.created_at).toISOString();
			const p = t.payload;
			switch (t.kind) {
				case "ci_agent_start":
					lines.push(`- #${t.seq} ${at} **start** ${clip({ provider: p.provider, model: p.model, origin: p.origin, cycle: p.cycle, test_command: p.test_command }, 300)}`);
					break;
				case "ci_agent_reasoning":
					lines.push(`- #${t.seq} ${at} **model** (step ${String(p.step)}): ${clip(p.text, 600) || "(tool call only)"}${Array.isArray(p.tool_calls) && p.tool_calls.length ? ` → ${p.tool_calls.join(", ")}` : ""}`);
					break;
				case "ci_agent_tool":
					lines.push(`- #${t.seq} ${at} **tool ${t.tool_name}** ${clip(t.tool_input, 200)} → ${clip(t.tool_output, 200)}`);
					break;
				case "ci_agent_gate":
					lines.push(`- #${t.seq} ${at} **gate** ${p.passed ? "PASSED" : "FAILED"}: ${clip(p.summary, 200)}`);
					break;
				case "ci_agent_decision":
					lines.push(`- #${t.seq} ${at} **decision ${String(p.decision)}**: ${clip(p.root_cause ?? p.reason, 300)}`);
					if (p.rationale) lines.push(`  - rationale: ${clip(p.rationale, 800)}`);
					break;
				default:
					lines.push(`- #${t.seq} ${at} **${t.kind}** ${clip(p, 300)}`);
			}
		}
		lines.push("");
	}

	if (
		record.classifications.length === 0 &&
		record.fix_attempts.length === 0 &&
		record.escalations.length === 0 &&
		record.agent_trace.length === 0
	) {
		lines.push("_No decisions recorded yet for this run._", "");
	}

	return lines.join("\n");
}

// ── CLI ───────────────────────────────────────────────────────────────

const isDirectRun =
	import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` ||
	process.argv[1]?.endsWith("src/audit/reconstruct.ts");

if (isDirectRun) {
	const runId = process.argv.slice(2)[0];
	if (!runId) {
		console.error("Usage: npx tsx src/audit/reconstruct.ts <run-id>");
		process.exit(1);
	}
	const pool = getPool();
	try {
		const record = await reconstructRun(pool, runId);
		console.log(renderRunAuditMarkdown(record));
	} catch (err) {
		console.error(String(err instanceof Error ? err.message : err));
		process.exit(1);
	} finally {
		await pool.end();
	}
}
