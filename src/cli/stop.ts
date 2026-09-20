// `self-healer stop` — stop the daemon started by `self-healer start`.
// Reads data/self-healer.pid, sends SIGTERM, waits for a graceful exit, then
// clears the pid file.

import {
	daemonPidPath,
	isProcessAlive,
	readPidFile,
	removePidFile,
} from "./pidfile.ts";

export interface StopOptions {
	/** App root for the pid file (defaults to process.cwd()). */
	cwd?: string;
	/** How long to wait for the daemon to exit after SIGTERM. */
	signalTimeoutMs?: number;
}

const sleep = (ms: number): Promise<void> =>
	new Promise((r) => setTimeout(r, ms));

export async function cliStop(options: StopOptions = {}): Promise<void> {
	const cwd = options.cwd ?? process.cwd();
	const pidPath = daemonPidPath(cwd);
	const timeoutMs = options.signalTimeoutMs ?? 3_000;

	const pid = readPidFile(pidPath);
	if (pid === undefined) {
		console.log("· no Self-Healer daemon running (no pid file)");
		return;
	}
	if (!isProcessAlive(pid)) {
		console.log(`· pid ${pid} is not running — clearing stale pid file`);
		removePidFile(pidPath);
		return;
	}

	console.log(`▶ stopping Self-Healer daemon (pid ${pid})...`);
	try {
		process.kill(pid, "SIGTERM");
	} catch (err) {
		console.error(`✗ could not signal pid ${pid}: ${String(err)}`);
		process.exit(1);
	}

	const deadline = Date.now() + timeoutMs;
	while (isProcessAlive(pid) && Date.now() < deadline) {
		await sleep(50);
	}

	removePidFile(pidPath);
	if (isProcessAlive(pid)) {
		console.log(
			`⚠ pid ${pid} still running after SIGTERM (check data/self-healer.log)`,
		);
	} else {
		console.log("✔ daemon stopped");
	}
}
