import { MAX_LLM_CALLS, PIPELINE_BUDGET_MS } from "../types.ts";

/**
 * Tracks the 10-minute pipeline timer and ≤3 LLM-call cap.
 * Call `tickLlm()` on each model call; check `isExpired()` before any action.
 */
export class PipelineBudget {
	private startedAt: number;
	private llmCallsLeft: number;

	constructor(
		startedAt: Date = new Date(),
		initialLlmCalls: number = MAX_LLM_CALLS,
	) {
		this.startedAt = startedAt.getTime();
		this.llmCallsLeft = initialLlmCalls;
	}

	/** Time elapsed since pipeline started (ms). */
	elapsedMs(): number {
		return Date.now() - this.startedAt;
	}

	/** True if the pipeline timer has exceeded the budget. */
	isExpired(): boolean {
		return this.elapsedMs() >= PIPELINE_BUDGET_MS;
	}

	/** True if any LLM calls remain. */
	hasLlmCallsLeft(): boolean {
		return this.llmCallsLeft > 0;
	}

	/** Consume one LLM call. Returns true if successful, false if budget exhausted. */
	tickLlm(): boolean {
		if (this.llmCallsLeft <= 0) return false;
		this.llmCallsLeft--;
		return true;
	}

	/** Remaining LLM calls. */
	remainingLlmCalls(): number {
		return this.llmCallsLeft;
	}
}
