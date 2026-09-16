// T028 — fix-scope allowlist + one-attempt cap + branch naming
// (contracts/fix-attempt.md)

import { describe, expect, it } from "vitest";
import {
	getAllowlist,
	matchPattern,
} from "../../src/pipeline/fixscope/allowlist.ts";
import { fixBranchName } from "../../src/pipeline/fixscope/record.ts";
import { MULTI_FILE_THRESHOLD } from "../../src/types.ts";

const ACTIVE = new Set(["lint/format", "import/type"]);
const STUBS = new Set(["snapshot", "timeout"]);

describe("allowlist (data-driven registry)", () => {
	it("ships exactly lint/format + import/type as the active patterns", () => {
		const list = getAllowlist();
		expect(list.length).toBeGreaterThanOrEqual(4); // 2 active + 2 stubs
		expect(new Set(list.map((e) => e.id))).toEqual(
			new Set([...ACTIVE, ...STUBS]),
		);
		for (const entry of list) {
			if (ACTIVE.has(entry.id)) {
				// Active patterns carry a working detect, a verifier command, and a
				// root-cause line for the CI-run comment.
				expect(entry.verifyCommand.length).toBeGreaterThan(0);
				expect(entry.rootCause?.length).toBeGreaterThan(0);
			} else {
				// Post-MVP stubs must not match
				expect(STUBS.has(entry.id)).toBe(true);
				expect(entry.detect("any failure log")).toBe(false);
				expect(entry.verifyCommand).toBe("");
			}
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

	it("matches a ReferenceError log to import/type (exact Node format)", () => {
		const log = [
			"##[error]ReferenceError: renderWidget is not defined",
			"    at file:///home/runner/work/demo-repo/demo-repo/src/main.mjs:3:1",
			"    at ModuleJob.run (node:internal/modules/esm/module_job:271:25)",
		].join("\n");
		expect(matchPattern(log)?.id).toBe("import/type");
	});

	it("does not match TypeError or 'Cannot find module' to import/type", () => {
		expect(
			matchPattern("TypeError: renderWidget is not a function"),
		).toBeUndefined();
		expect(matchPattern("Cannot find module './renderer.mjs'")).toBeUndefined();
		expect(
			matchPattern("ReferenceError: something else happened here"),
		).toBeUndefined();
	});

	it("prefers lint/format when both signals are present (registry order)", () => {
		const log = [
			"biome check found 2 lint errors in src/widget.ts",
			"##[error]ReferenceError: renderWidget is not defined",
		].join("\n");
		expect(matchPattern(log)?.id).toBe("lint/format");
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
