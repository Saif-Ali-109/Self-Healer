// T0XX — fix-only PR delivery (constitution v1.2.0 — Human-Approved Delivery)
// (contracts/fix-attempt.md rule 5)

import { describe, expect, it } from "vitest";
import {
	buildFixPrBody,
	buildFixPrTitle,
	openFixPr,
} from "../../src/pipeline/fixscope/fixpr.ts";

const base = {
	externalRunId: "1234567890",
	pattern: "lint/format",
	branch: "ci-fix/01234567",
	baseBranch: "feat/demo-fix-trigger",
	diffSummary: "1 files changed",
	verification: "npx @biomejs/biome check .: passed",
};

describe("buildFixPrTitle", () => {
	it("references the failing run id", () => {
		expect(buildFixPrTitle("1234567890")).toBe(
			"🤖 Self-Healer: auto-fix for CI run #1234567890",
		);
	});
});

describe("buildFixPrBody", () => {
	it("describes the fix and the review-first flow", () => {
		const body = buildFixPrBody(base);
		expect(body).toContain("CI run `#1234567890`");
		expect(body).toContain("**Pattern matched**: `lint/format`");
		expect(body).toContain("**Branch**: `ci-fix/01234567`");
		expect(body).toContain("**Base**: `feat/demo-fix-trigger`");
		expect(body).toContain("**Diff summary**: 1 files changed");
		expect(body).toContain("**Verification**: npx @biomejs/biome check .: passed");
		expect(body).toContain("The agent never merges");
	});
});

describe("openFixPr", () => {
	it("returns null in dry-run mode without touching GitHub", async () => {
		process.env.CI_POST_COMMENTS = "0";
		// No pool access needed: guarded before any DB/gh call.
		await expect(
			openFixPr({} as never, {
				...base,
				runId: "run-1",
				repo: "acme/widget",
				headBranch: base.branch,
			}),
		).resolves.toBeNull();
		delete process.env.CI_POST_COMMENTS;
	});
});