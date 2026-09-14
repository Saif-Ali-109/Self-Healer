// T042 — security: secret redaction + zero secrets in fixtures.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { redactSecrets } from "../../src/pipeline/comments.ts";

const SECRET_PATTERNS = [
	/gh[pous]_[A-Za-z0-9_]{10,}/,
	/github_pat_[A-Za-z0-9_]{20,}/,
	/sk-[A-Za-z0-9]{16,}/,
	/GH_TOKEN\s*=\s*\S+/,
	/CI_WEBHOOK_SECRET\s*=\s*\S+/,
];

describe("redactSecrets", () => {
	it("redacts classic PATs", () => {
		const out = redactSecrets(
			"token ghp_0123456789abcdef0123456789abcdef01234567 here",
		);
		expect(out).toContain("***");
		expect(out).not.toMatch(/ghp_[A-Za-z0-9]/);
	});

	it("redacts fine-grained PATs", () => {
		const out = redactSecrets(
			"pat github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopqrstuvwxyz001122",
		);
		expect(out).toContain("***");
		expect(out).not.toMatch(/github_pat_/);
	});

	it("redacts sk- style API keys", () => {
		const out = redactSecrets("key sk-0123456789abcdef0123456789abcdef");
		expect(out).toContain("***");
		expect(out).not.toMatch(/sk-[A-Za-z0-9]/);
	});

	it("leaves ordinary text intact", () => {
		const out = redactSecrets("failed with ECONNRESET at line 12");
		expect(out).toBe("failed with ECONNRESET at line 12");
	});
});

describe("fixtures contain no secrets", () => {
	it("github-workflow-job-fail.json is clean", () => {
		const fixture = readFileSync(
			"tests/fixtures/github-workflow-job-fail.json",
			"utf8",
		);
		for (const re of SECRET_PATTERNS) {
			expect(fixture).not.toMatch(re);
		}
	});
});
