// CLI parsing + env generation — pure functions, no process/fs side effects.
// The `enable --repo` space-vs-equals bug found in live use is covered here so
// the parser can never regress without a failing test.

import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../../src/cli/args.ts";
import { generateSecret, renderEnvFile } from "../../src/cli/init.ts";

describe("parseCliArgs", () => {
	it("defaults to help with no args", () => {
		expect(parseCliArgs([]).command).toBe("help");
	});

	it("parses init and --force", () => {
		expect(parseCliArgs(["init"]).command).toBe("init");
		expect(parseCliArgs(["init"]).force).toBe(false);
		expect(parseCliArgs(["init", "--force"]).force).toBe(true);
	});

	it("parses enable --repo owner/repo (space form)", () => {
		const a = parseCliArgs(["enable", "--repo", "acme/widget"]);
		expect(a.command).toBe("enable");
		expect(a.repo).toBe("acme/widget");
		expect(a.repoValid).toBe(true);
	});

	it("parses enable --repo=owner/repo (equals form — the fixed bug)", () => {
		const a = parseCliArgs(["enable", "--repo=acme/widget"]);
		expect(a.command).toBe("enable");
		expect(a.repo).toBe("acme/widget");
		expect(a.repoValid).toBe(true);
	});

	it("enable without --repo is invalid", () => {
		const a = parseCliArgs(["enable"]);
		expect(a.repo).toBeUndefined();
		expect(a.repoValid).toBe(false);
	});

	it("enable --repo with a missing value is invalid", () => {
		const a = parseCliArgs(["enable", "--repo"]);
		expect(a.repo).toBeUndefined();
		expect(a.repoValid).toBe(false);
	});

	it("rejects repos that are not owner/repo shape", () => {
		for (const bad of [
			"acme",
			"acme/",
			"/widget",
			"acme/widget/extra",
			"ac me/wid get",
		]) {
			const a = parseCliArgs(["enable", "--repo", bad]);
			expect(a.repoValid, `expected ${bad} to be invalid`).toBe(false);
		}
	});

	it("accepts dotted/underscored/dashed owner and repo names", () => {
		const a = parseCliArgs(["enable", "--repo", "my-org.Name_1/sub.team-2"]);
		expect(a.repoValid).toBe(true);
	});

	it("parses start and --foreground", () => {
		expect(parseCliArgs(["start"]).foreground).toBe(false);
		expect(parseCliArgs(["start", "--foreground"]).foreground).toBe(true);
	});

	it("parses status", () => {
		expect(parseCliArgs(["status"]).command).toBe("status");
	});

	it("parses stop", () => {
		const a = parseCliArgs(["stop"]);
		expect(a.command).toBe("stop");
		expect(a.foreground).toBe(false);
	});

	it("maps help / --help / -h through for the dispatcher", () => {
		for (const c of ["help", "--help", "-h"]) {
			expect(parseCliArgs([c]).command).toBe(c);
		}
	});

	it("passes unknown commands through so the dispatcher rejects them", () => {
		expect(parseCliArgs(["frobnicate"]).command).toBe("frobnicate");
	});

	it("reports flags only where they apply", () => {
		const a = parseCliArgs(["enable", "--repo=o/r", "--force", "--foreground"]);
		expect(a.force).toBe(true);
		expect(a.foreground).toBe(true);
		const b = parseCliArgs(["status", "--force"]);
		expect(b.force).toBe(true);
		expect(b.foreground).toBe(false);
	});
});

describe("generateSecret", () => {
	it("is a 32-byte hex string (64 chars, [0-9a-f])", () => {
		const s = generateSecret();
		expect(s).toMatch(/^[0-9a-f]{64}$/);
	});

	it("produces distinct values", () => {
		expect(generateSecret()).not.toBe(generateSecret());
	});
});

describe("renderEnvFile", () => {
	const TEMPLATE = [
		"GH_TOKEN=",
		"CI_WEBHOOK_SECRET=",
		"DATABASE_URL=./some/where.db",
		"SOR_SIGNING_KEY=",
		"SOR_KEY_ID=v1",
		"",
	].join("\n");

	it("fills CI_WEBHOOK_SECRET and SOR_SIGNING_KEY with the secret", () => {
		const out = renderEnvFile(TEMPLATE, "deadbeef");
		expect(out).toContain("CI_WEBHOOK_SECRET=deadbeef");
		expect(out).toContain("SOR_SIGNING_KEY=deadbeef");
	});

	it("normalizes DATABASE_URL to the local data dir", () => {
		const out = renderEnvFile(TEMPLATE, "deadbeef");
		expect(out).toContain("DATABASE_URL=./data/self-healer.db");
		expect(out).not.toContain("./some/where.db");
	});

	it("keeps unrelated keys (GH_TOKEN, SOR_KEY_ID) untouched", () => {
		const out = renderEnvFile(TEMPLATE, "deadbeef");
		expect(out).toContain("GH_TOKEN=");
		expect(out).toContain("SOR_KEY_ID=v1");
	});

	it("is a pure rewrite (no secret leaks into non-secret keys)", () => {
		const out = renderEnvFile(TEMPLATE, "cafe1234");
		expect(out).not.toMatch(/^GH_TOKEN=.*cafe/m);
	});
});
