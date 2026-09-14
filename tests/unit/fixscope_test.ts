// T028 — fix-scope allowlist + one-attempt cap + branch naming
// (contracts/fix-attempt.md)

import { describe, expect, it } from "vitest";
import {
	getAllowlist,
	matchPattern,
} from "../../src/pipeline/fixscope/allowlist.ts";
import { fixBranchName } from "../../src/pipeline/fixscope/record.ts";
import { MULTI_FILE_THRESHOLD } from "../../src/types.ts";

describe("allowlist (data-driven registry)", () => {
	it("ships lint/format as the only active MVP pattern", () => {
		const list = getAllowlist();
		expect(list.length).toBeGreaterThanOrEqual(4); // 1 active + 3 stubs
		const lint = list.find((e) => e.id === "lint/format");
		expect(lint).toBeDefined();
		expect(lint?.verifyCommand.length).toBeGreaterThan(0);
		// Post-MVP stubs must not match
		for (const entry of list.filter((e) => e.id !== "lint/format")) {
			expect(entry.detect("any failure log")).toBe(false);
		}
	});

	it("matches a lint error log to lint/format", () => {
		const log = "biome check found 2 lint errors in src/widget.ts";
		expect(matchPattern(log)?.id).toBe("lint/format");
	});

	it("matches eslint/prettier output", () => {
		expect(
			matchPattern("ESLint: 1 error, formatting issue at line 4")?.id,
		).toBe("lint/format");
	});

	it("returns undefined when no pattern matches (→ no_pattern_match escalation)", () => {
		expect(matchPattern("snapshot mismatch in widget test")).toBeUndefined();
		expect(
			matchPattern("TypeError: cannot read properties of undefined"),
		).toBeUndefined();
		expect(matchPattern("")).toBeUndefined();
	});
});

describe("fix branch naming", () => {
	it("uses ci-fix/<run-id> with the run id prefix", () => {
		expect(fixBranchName("01234567-9abc-def0-1234-56789abcdef0")).toBe(
			"ci-fix/01234567",
		);
		expect(
			fixBranchName("01234567-9abc-def0-1234-56789abcdef0").startsWith(
				"ci-fix/",
			),
		).toBe(true);
	});
});

describe("multi-file guardrail constant", () => {
	it("escalates at 5+ files (constitution guardrail)", () => {
		expect(MULTI_FILE_THRESHOLD).toBe(5);
	});
});
