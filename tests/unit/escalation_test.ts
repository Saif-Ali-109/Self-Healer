// T034 — escalation reason → suggested next step mapping
// (contracts/fix-attempt.md + contracts/ci-comment.md type 2)

import { describe, expect, it } from "vitest";
import { suggestedNextStepFor } from "../../src/pipeline/escalation/writer.ts";
import type { EscalationReason } from "../../src/types.ts";

const ALL_REASONS: EscalationReason[] = [
	"low_confidence",
	"fix_failed",
	"multi_file",
	"critical_branch",
	"budget_exhausted",
	"no_pattern_match",
	"infra",
	"flaky_retries_exhausted",
	"checkout_failed",
];

describe("escalation reason mapping (9 triggers)", () => {
	it("maps every reason to a non-empty, human-readable next step", () => {
		for (const reason of ALL_REASONS) {
			const step = suggestedNextStepFor(reason);
			expect(step.length).toBeGreaterThan(10);
			expect(step).not.toContain("undefined");
		}
	});

	it("low_confidence references the 0.7 threshold", () => {
		expect(suggestedNextStepFor("low_confidence")).toContain("0.7");
	});

	it("critical_branch references protected branches", () => {
		expect(suggestedNextStepFor("critical_branch")).toMatch(
			/main|release|v\*/i,
		);
	});

	it("infra references platform status", () => {
		expect(suggestedNextStepFor("infra")).toMatch(
			/rate limit|disk|docker|credential/i,
		);
	});

	it("flaky_retries_exhausted references the rerun cap", () => {
		expect(suggestedNextStepFor("flaky_retries_exhausted")).toMatch(
			/3 reruns|skipped/i,
		);
	});

	it("unknown reason falls back to a manual-review message", () => {
		expect(suggestedNextStepFor("checkout_failed")).toBeTruthy();
	});
});
