import type { Pool } from "pg";
import { chainCiEvent } from "../../sor/ciEvents.ts";
import type { ClassificationResult } from "../../types.ts";
import { CLASSIFIER_VERSION } from "../../types.ts";
import { classifyFromSignals, detectSignals } from "./signals.ts";

/**
 * Fetch job logs via gh CLI (best-effort).
 */
async function fetchJobLogs(logUrl: string): Promise<string> {
	try {
		const { execFile } = await import("node:child_process");
		const { promisify } = await import("node:util");
		const exec = promisify(execFile);
		// logUrl is the check_run_url; gh api can fetch logs via the check-run ID
		const match = logUrl.match(/\/jobs\/(\d+)$/);
		if (!match) return "";
		const jobId = match[1];
		// Try gh api to get the log text
		const result = await exec(
			"gh",
			["api", `repos/{owner}/{repo}/actions/jobs/${jobId}/logs`, "--jq", "."],
			{ maxBuffer: 32 * 1024 * 1024 },
		);
		return result.stdout;
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
	logUrl: string,
): Promise<ClassificationResult> {
	const logText = await fetchJobLogs(logUrl);
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
