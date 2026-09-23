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

	it("describes an AI-agent fix (root cause, model, re-fix cycle) without a pattern", () => {
		const body = buildFixPrBody({
			externalRunId: "9876543210",
			rootCause: "Missing export breaks the build.",
			summary: "Added the missing export in src/main.ts",
			reasoning: "Logs point at the unresolved symbol.",
			model: "openrouter/anthropic/claude-3.5-sonnet",
			cycle: 2,
			maxCycles: 3,
			warnings: ["Edited tests to match the new behavior."],
			branch: "ci-fix/01234567",
			baseBranch: "feat/demo-fix-trigger",
			diffSummary: "1 file(s): src/main.ts",
			verification: "node src/main.mjs: passed",
		});
		expect(body).not.toContain("**Pattern matched**");
		expect(body).toContain("**Root cause**: Missing export breaks the build.");
		expect(body).toContain("**What changed**: Added the missing export in src/main.ts");
		expect(body).toContain("**Agent reasoning**: Logs point at the unresolved symbol.");
		expect(body).toContain("**Model**: `openrouter/anthropic/claude-3.5-sonnet`");
		expect(body).toContain("**Re-fix cycle**: 2 of 3");
		expect(body).toContain("> ⚠️ Edited tests to match the new behavior.");
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

	it("returns null when head equals base (re-fix cycle, never a head==base PR)", async () => {
		process.env.CI_POST_COMMENTS = "1";
		// Even with comments enabled, same head/base is rejected before any gh call.
		await expect(
			openFixPr({} as never, {
				...base,
				runId: "run-1",
				repo: "acme/widget",
				headBranch: "ci-fix/01234567",
				baseBranch: "ci-fix/01234567",
			}),
		).resolves.toBeNull();
		delete process.env.CI_POST_COMMENTS;
	});
});