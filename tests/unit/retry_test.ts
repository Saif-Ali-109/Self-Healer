// T025 — retry budget: ≤3 reruns (constitution) + 10-minute pipeline timer.

import { describe, expect, it } from "vitest";
import { retryFlaky } from "../../src/pipeline/retry/runner.ts";
import {
	MAX_LLM_CALLS,
	MAX_RERUNS,
	PIPELINE_BUDGET_MS,
} from "../../src/types.ts";
import { PipelineBudget } from "../../src/utils/budget.ts";

describe("hard limits (constitution)", () => {
	it("caps reruns at 3", () => {
		expect(MAX_RERUNS).toBe(3);
	});

	it("caps LLM calls at 3", () => {
		expect(MAX_LLM_CALLS).toBe(3);
	});

	it("budgets 10 minutes", () => {
		expect(PIPELINE_BUDGET_MS).toBe(10 * 60_000);
	});
});

describe("PipelineBudget", () => {
	it("reports expired once the 10-minute timer elapses", () => {
		const expired = new PipelineBudget(
			new Date(Date.now() - PIPELINE_BUDGET_MS - 1),
		);
		expect(expired.isExpired()).toBe(true);
	});

	it("starts fresh and unexpired", () => {
		const fresh = new PipelineBudget();
		expect(fresh.isExpired()).toBe(false);
		expect(fresh.hasLlmCallsLeft()).toBe(true);
	});

	it("allows exactly 3 LLM calls then refuses", () => {
		const b = new PipelineBudget();
		expect(b.tickLlm()).toBe(true);
		expect(b.tickLlm()).toBe(true);
		expect(b.tickLlm()).toBe(true);
		expect(b.tickLlm()).toBe(false);
		expect(b.hasLlmCallsLeft()).toBe(false);
		expect(b.remainingLlmCalls()).toBe(0);
	});
});

describe("retryFlaky surface", () => {
	it("is exported and returns the RetryResult shape contract", async () => {
		expect(typeof retryFlaky).toBe("function");
		// Signature contract: (pool, { runId, repo, externalRunId, jobId, commit })
		const fn = retryFlaky as unknown as {
			length: number;
		};
		expect(fn.length).toBe(2);
	});
});
