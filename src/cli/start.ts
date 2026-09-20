// `self-healer start` — run the daemon (webhook :3457 + FIFO worker).
// Foreground: run bundled `startDaemon` in this process.
// Default: detached child of the packaged daemon bundle (dist/daemon.mjs)
// logging to data/self-healer.log (the agent's own data dir).

import { spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config.ts";
import { resolveDbPath } from "../db/sqlite.ts";
import { startDaemon } from "../index.ts";
import { packagePath } from "../paths.ts";

const INDEX_PATH = packagePath("dist", "daemon.mjs");

export async function cliStart(foreground = false): Promise<void> {
	const config = loadConfig(); // validates env + loads .env

	if (foreground) {
		console.log(
			`▶ Self-Healer starting in foreground (webhook :${config.webhookPort})`,
		);
		await startDaemon(); // blocks until shutdown
		return;
	}

	const logDir = join(process.cwd(), "data");
	mkdirSync(logDir, { recursive: true });
	const logPath = join(logDir, "self-healer.log");
	const logFd = openSync(logPath, "a");
	const child = spawn(process.execPath, [INDEX_PATH], {
		detached: true,
		stdio: ["ignore", logFd, logFd],
		env: process.env,
		cwd: process.cwd(),
	});
	child.unref();

	console.log(`▶ Self-Healer daemon started (pid ${child.pid})`);
	console.log(`  webhook :${config.webhookPort} → db ${resolveDbPath()}`);
	console.log(`  logs: ${logPath}`);
	console.log(`  stop with: kill ${child.pid}`);
}
