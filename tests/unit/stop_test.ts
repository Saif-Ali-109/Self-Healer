// T054 — `self-healer stop` + pid-file bookkeeping: write/read/remove roundtrip,
// liveness probes, status rendering, and a real SIGTERM stop against a child.

import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
	daemonPidPath,
	daemonStatusText,
	isProcessAlive,
	readPidFile,
	removePidFile,
	writePidFile,
} from "../../src/cli/pidfile.ts";
import { cliStop } from "../../src/cli/stop.ts";

const tmp = mkdtempSync(join(tmpdir(), "self-healer-stop-"));
const DATA_DIR = join(tmp, "data");
const PID_PATH = join(DATA_DIR, "self-healer.pid");

/** Child with the default SIGTERM handler that stays alive until killed.
 *  `pid` is populated synchronously by spawn(); narrowed here so call sites
 *  stay assertion-free. */
function spawnChild(): { child: ReturnType<typeof spawn>; pid: number } {
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
		stdio: "ignore",
	});
	return { child, pid: child.pid as number };
}

async function killAndReap(child: ReturnType<typeof spawn>): Promise<void> {
	child.kill("SIGKILL");
	await once(child, "exit");
}

/** Capture console.log calls for the duration of fn(). */
async function withLogCapture(fn: () => Promise<void>): Promise<string> {
	const lines: string[] = [];
	const spy = vi
		.spyOn(console, "log")
		.mockImplementation((...parts: unknown[]) => {
			lines.push(parts.map(String).join(" "));
		});
	try {
		await fn();
	} finally {
		spy.mockRestore();
	}
	return lines.join("\n");
}

afterAll(() => {
	rmSync(tmp, { recursive: true, force: true });
});

describe("pid file helpers", () => {
	it("write → read roundtrip", () => {
		mkdirSync(DATA_DIR, { recursive: true });
		writePidFile(PID_PATH, 4242);
		expect(readPidFile(PID_PATH)).toBe(4242);
	});

	it("read returns undefined for missing / garbage / non-positive pids", () => {
		expect(readPidFile(join(tmp, "data", "missing.pid"))).toBeUndefined();
		mkdirSync(DATA_DIR, { recursive: true });
		const cases: Array<[string, string]> = [
			["garbage.pid", "not-a-pid"],
			["zero.pid", "0"],
			["neg.pid", "-5"],
			["float.pid", "3.7"],
		];
		for (const [name, content] of cases) {
			writeFileSync(join(DATA_DIR, name), content);
			expect(readPidFile(join(DATA_DIR, name))).toBeUndefined();
		}
	});

	it("removePidFile reports whether the file existed", () => {
		writePidFile(PID_PATH, 7);
		expect(removePidFile(PID_PATH)).toBe(true);
		expect(removePidFile(PID_PATH)).toBe(false);
	});

	it("daemonPidPath points into <cwd>/data", () => {
		expect(daemonPidPath("/some/root")).toBe(
			join("/some/root", "data", "self-healer.pid"),
		);
	});
});

describe("isProcessAlive", () => {
	it("is true for a live child and false after it exits", async () => {
		const { child, pid } = spawnChild();
		expect(isProcessAlive(pid)).toBe(true);
		await killAndReap(child);
		await new Promise((r) => setTimeout(r, 20));
		expect(isProcessAlive(pid)).toBe(false);
	});

	it("is false for nonsense pids", () => {
		expect(isProcessAlive(0)).toBe(false);
		expect(isProcessAlive(-1)).toBe(false);
		expect(isProcessAlive(Number.NaN)).toBe(false);
	});
});

describe("daemonStatusText", () => {
	it("reports stopped when there is no pid file", () => {
		expect(daemonStatusText(join(DATA_DIR, "absent.pid"))).toBe("stopped");
	});

	it("reports running (pid N) for a live child", async () => {
		const { child, pid } = spawnChild();
		const path = join(DATA_DIR, "live.pid");
		writePidFile(path, pid);
		expect(daemonStatusText(path)).toBe(`running (pid ${pid})`);
		await killAndReap(child);
	});

	it("reports stopped for a stale pid", async () => {
		const { child, pid } = spawnChild();
		const path = join(DATA_DIR, "stale.pid");
		writePidFile(path, pid);
		await killAndReap(child);
		await new Promise((r) => setTimeout(r, 20));
		expect(daemonStatusText(path)).toBe("stopped");
	});
});

describe("cliStop", () => {
	it("stops a running daemon and clears the pid file", async () => {
		const { child, pid } = spawnChild();
		mkdirSync(DATA_DIR, { recursive: true });
		writePidFile(PID_PATH, pid);
		const exited = once(child, "exit");

		const output = await withLogCapture(() =>
			cliStop({ cwd: tmp, signalTimeoutMs: 2_000 }),
		);

		await exited;
		expect(output).toContain("✔ daemon stopped");
		expect(readPidFile(PID_PATH)).toBeUndefined();
	});

	it("is a no-op with a clear message when no pid file exists", async () => {
		const output = await withLogCapture(() =>
			cliStop({ cwd: tmp, signalTimeoutMs: 200 }),
		);
		expect(output).toContain("no Self-Healer daemon running");
	});

	it("clears a stale pid file (pid not running)", async () => {
		const cwd = join(tmp, "stale-cwd");
		mkdirSync(join(cwd, "data"), { recursive: true });
		// pid_max is ~4M on Linux; this can never be a live process.
		writePidFile(daemonPidPath(cwd), 999_000_000);

		const output = await withLogCapture(() =>
			cliStop({ cwd, signalTimeoutMs: 200 }),
		);
		expect(output).toContain("not running — clearing stale pid file");
		expect(readPidFile(daemonPidPath(cwd))).toBeUndefined();
	});
});
