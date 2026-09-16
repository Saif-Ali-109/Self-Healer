import type { Pool } from "pg";
import { chainCiEvent } from "../../sor/ciEvents.ts";
import type { ClassificationResult } from "../../types.ts";
import { CLASSIFIER_VERSION } from "../../types.ts";
import { classifyFromSignals, detectSignals } from "./signals.ts";

/**
 * GitHub Actions job logs (raw text) prefix every line with an ISO timestamp:
 *   `2026-09-16T14:05:26.3140171Z <content>`
 * The microsecond digits can contain sequences like `401`, `429` or `503`,
 * which the infra signal detector would otherwise misread as HTTP status
 * codes (documented false positive). Strip the prefix (and the leading UTF-8
 * BOM) before signal detection.
 */
export function stripLogTimestamps(logText: string): string {
	return logText
		.replace(/^\uFEFF/, "")
		.split("\n")
		.map((line) =>
			line.replace(
				/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s*/,
				"",
			),
		)
		.join("\n");
}

/**
 * Fetch job logs via gh CLI (best-effort).
 * Shared by the classifier and the fix-scope allowlist matcher so both see
 * the same cleaned log text (BOM + timestamp prefixes stripped).
 */
export async function fetchJobLogs(
	repo: string,
	logUrl: string,
): Promise<string> {
	try {
		const { execFile } = await import("node:child_process");
		const { promisify } = await import("node:util");
		const exec = promisify(execFile);
		// logUrl is the job URL (…/actions/jobs/<id>); gh api can fetch the log text.
		const match = logUrl.match(/\/jobs\/(\d+)$/);
		if (!match) return "";
		const jobId = match[1];
		// The logs endpoint returns plain text (not JSON), so no --jq flag.
		const result = await exec(
			"gh",
			["api", `repos/${repo}/actions/jobs/${jobId}/logs`],
			{ maxBuffer: 32 * 1024 * 1024 },
		);
		return stripLogTimestamps(result.stdout);
	} catch {
		return ""; // best-effort
	}
}

/**
 * Run the rule-first classifier on a failed CI run.
 * 1. Fetch logs
 * 2. Detect signals
 * 3. Classify
 * 4. Persist to classifications table + SOR
 * 5. Return ClassificationResult
 */
export async function classify(
	pool: Pool,
	runId: string,
	repo: string,
	logUrl: string,
): Promise<ClassificationResult> {
	const logText = await fetchJobLogs(repo, logUrl);
	const signals = detectSignals(logText);
	const { category, confidence, evidence } = classifyFromSignals(signals);

	const result: ClassificationResult = {
		run_id: runId,
		category,
		confidence,
		evidence,
		classifier_version: CLASSIFIER_VERSION,
		decided_at: new Date().toISOString(),
	};

	// Persist classification
	try {
		await pool.query(
			`INSERT INTO classifications (run_id, category, confidence, evidence, classifier_version, summary, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())`,
			[
				runId,
				category,
				confidence,
				JSON.stringify(evidence),
				CLASSIFIER_VERSION,
				`Rule-first classification: ${category} (confidence ${confidence}). Signals: ${evidence.map((e) => e.signal).join(", ") || "none"}.`,
			],
		);
	} catch (err) {
		console.error("[classifier] failed to persist classification:", err);
	}

	// Chain to SOR
	await chainCiEvent(pool, runId, "ci_classification", {
		category,
		confidence,
		evidence,
		classifier_version: CLASSIFIER_VERSION,
	});

	return result;
}
