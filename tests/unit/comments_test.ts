import { describe, expect, it } from "vitest";
import {
	buildFixCommentBody,
	pickCommentTarget,
} from "../../src/pipeline/comments.ts";

describe("pickCommentTarget", () => {
	it("prefers the first pull request number", () => {
		expect(pickCommentTarget([42, 7], "abc123")).toBe("issues/42");
	});

	it("falls back to commit comments when the run is not a PR", () => {
		expect(pickCommentTarget(undefined, "abc123")).toBe("commits/abc123");
		expect(pickCommentTarget([], "abc123")).toBe("commits/abc123");
	});

	it("returns null when nothing can host a comment", () => {
		expect(pickCommentTarget(undefined, "")).toBeNull();
		expect(pickCommentTarget([], "")).toBeNull();
	});
});

describe("buildFixCommentBody", () => {
	const opts = {
		rootCause: "Lint/format issues detected in the failing job.",
		pattern: "lint/format",
		branch: "ci-fix/01234567",
		diffSummary: "1 files changed",
		verification: "npx @biomejs/biome check .: passed",
	};

	it("omits the PR line when no fix PR was opened", () => {
		const body = buildFixCommentBody(opts);
		expect(body).toContain("**Branch**: `ci-fix/01234567`");
		expect(body).not.toContain("**Pull request**");
		expect(body).toContain("no PR was opened and nothing was merged");
		expect(body).toContain("Review and merge at your discretion");
	});

	it("includes the fix PR review link when one was opened (v3.0.0)", () => {
		const body = buildFixCommentBody({
			...opts,
			fixPrUrl: "https://github.com/acme/widget/pull/99",
		});
		expect(body).toContain(
			"**Pull request**: https://github.com/acme/widget/pull/99 — review & merge when ready.",
		);
		expect(body).toContain("The agent never merges");
		// The "no PR was opened" wording must not leak into PR delivery comments.
		expect(body).not.toContain("no PR was opened");
	});
});