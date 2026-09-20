// T054 — daemon-bundle boot regression: dist/daemon.mjs (daemonEntry + the
// bundled src/index.ts guard) must boot the daemon exactly ONCE. The guard
// used to also match `dist/daemon.mjs`, so the bundled index.ts fired a second
// startDaemon() → second webhook bind → EADDRINUSE → Fatal → process.exit(1),
// killing the healthy first boot on every `self-healer start`.
//
// Skips when dist/daemon.mjs is missing or port 3457 is already bound (so the
// repo's own test env and parallel daemon runs don't false-fail). Requires a
// CURRENT dist/ — run `npm run build` (CI builds before running tests).

import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { packagePath } from "../../src/paths.ts";

const DAEMON = join(packagePath(), "dist", "daemon.mjs");
let child: ChildProcess | undefined;

async function portFree(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const probe = createServer();
		probe.once("error", () => resolve(false));
		probe.listen(port, "0.0.0.0", () => {
			probe.close(() => resolve(true));
		});
	});
}

afterAll(() => {
	// If an assertion failed mid-way, don't leave a stray daemon holding :3457.
	if (child && child.exitCode === null && child.signalCode === null) {
		child.kill("SIGKILL");
	}
});

describe("daemon bundle boot", () => {
	it("boots once, stays alive, and shuts down on SIGTERM", async () => {
		if (!existsSync(DAEMON)) return; // dist not built → skip silently
		const free = await portFree(3457);
		if (!free) return; // port busy → skip, don't false-fail

		child = spawn(process.execPath, [DAEMON], {
			cwd: packagePath(),
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		child.stdout?.on("data", (d) => (out += d));
		child.stderr?.on("data", (d) => (out += d));

		// Give the daemon time to boot (webhook bind + worker start).
		await new Promise((r) => setTimeout(r, 2_000));

		expect(child.exitCode, `daemon exited early. Output:\n${out}`).toBeNull();

		const starting = (out.match(/Self-Healer CI Agent starting/g) ?? []).length;
		const listening = (out.match(/CI webhook listening/g) ?? []).length;
		expect(
			starting,
			`expected one boot, got ${starting}. Output:\n${out}`,
		).toBe(1);
		expect(
			listening,
			`expected one webhook bind, got ${listening}. Output:\n${out}`,
		).toBe(1);
		expect(out).not.toContain("EADDRINUSE");

		// Graceful shutdown.
		const exited = once(child, "exit");
		child.kill("SIGTERM");
		const [code] = (await exited) as [number | null];
		expect(code).toBe(0);
		expect(out).toContain("▶ Shutting down...");
	}, 15_000);
});
