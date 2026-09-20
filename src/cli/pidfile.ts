// Daemon pid-file bookkeeping for `self-healer start` / `self-healer stop`.
// Pure helpers (path-scoped) so the CLI and tests can drive them deterministically.

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Standard pid-file location under an app root (defaults to process.cwd()). */
export function daemonPidPath(cwd = process.cwd()): string {
	return join(cwd, "data", "self-healer.pid");
}

export function writePidFile(path: string, pid: number): void {
	writeFileSync(path, String(pid), { mode: 0o600 });
}

/** Read + validate the pid file → pid, or undefined when missing/invalid. */
export function readPidFile(path: string): number | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const pid = Number(readFileSync(path, "utf8").trim());
		return Number.isInteger(pid) && pid > 0 ? pid : undefined;
	} catch {
		return undefined;
	}
}

/** Remove the pid file; reports whether it existed. */
export function removePidFile(path: string): boolean {
	if (!existsSync(path)) return false;
	unlinkSync(path);
	return true;
}

/** Signal-0 liveness probe. EPERM means the process exists (owned by someone
 *  else) — that still counts as alive. */
export function isProcessAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) {
		return false;
	}
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "EPERM") return true;
		return false;
	}
}

/** Render the daemon state line for `status`: "running (pid N)" | "stopped". */
export function daemonStatusText(pidPath: string): string {
	const pid = readPidFile(pidPath);
	return pid !== undefined && isProcessAlive(pid)
		? `running (pid ${pid})`
		: "stopped";
}
