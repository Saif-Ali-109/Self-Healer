import { describe, expect, it } from "vitest";
import { pickCommentTarget } from "../../src/pipeline/comments.ts";

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