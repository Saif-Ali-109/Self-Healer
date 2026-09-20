// Regression: v1.0.1's `enable` write path passed `--jq .html_url` to
// `gh pr create`, which rejects it (that flag is `gh pr view`/`gh api`
// territory). Live-found on a fresh repo: the branch + reporter file were
// committed, then `enable` died before opening the PR. The PR URL now comes
// from `gh pr create` stdout via the `gh()` helper (already trimmed).
// Pure argv builder + body — no subprocess, no DB.

import { describe, expect, it } from "vitest";
import { ENABLE_PR_BODY, prCreateArgs } from "../../src/cli/enable.ts";

describe("enable prCreateArgs (gh pr create argv)", () => {
	it("targets the reporter PR at repo/base/head", () => {
		const args = prCreateArgs("acme/widget", "main", "self-healer/enable");
		expect(args.indexOf("create")).toBe(args.indexOf("pr") + 1);
		expect(args[args.indexOf("--repo") + 1]).toBe("acme/widget");
		expect(args[args.indexOf("--base") + 1]).toBe("main");
		expect(args[args.indexOf("--head") + 1]).toBe("self-healer/enable");
		expect(args[args.indexOf("--title") + 1]).toBe(
			"🤖 Enable Self-Healer CI agent",
		);
		expect(args[args.indexOf("--body") + 1]).toBe(ENABLE_PR_BODY);
	});

	it("never passes --jq (the v1.0.1 live-found bug)", () => {
		const args = prCreateArgs("acme/widget", "main", "self-healer/enable");
		expect(args).not.toContain("--jq");
		expect(args).not.toContain(".html_url");
	});

	it("tells the human to add the two repo secrets before merging", () => {
		expect(ENABLE_PR_BODY).toContain("SELF_HEALER_URL");
		expect(ENABLE_PR_BODY).toContain("CI_WEBHOOK_SECRET");
		expect(ENABLE_PR_BODY).toContain("human merge");
	});
});
