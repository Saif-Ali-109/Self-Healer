// self-healer — CLI entry point (US6: install/enable/run the standalone agent).
// Usage:
//   self-healer init                  create .env + SQLite database
//   self-healer enable --repo o/r     write self-healer-notify.yml (PR) + register
//   self-healer start                 run the daemon (webhook :3457 + worker)
//   self-healer status                report db/queue/SOR/watch state

import { parseCliArgs } from "./args.ts";
import { cliEnable } from "./enable.ts";
import { cliInit } from "./init.ts";
import { cliStart } from "./start.ts";
import { cliStatus } from "./status.ts";

function printHelp(): void {
	console.log(`self-healer — CI failure agent (standalone, node:sqlite)

Usage:
  self-healer init [--force]          create .env + SQLite database, then migrate
  self-healer enable --repo owner/repo
                                      write self-healer-notify.yml to the repo via a
                                      PR (never merged by the agent) + register watched
  self-healer start [--foreground]    run the daemon: webhook on :3457 + FIFO worker
                                      (default: detached, logs to data/self-healer.log)
  self-healer status                  show database, pending queue, watched repos, SOR chain

Env (from .env — see .env.example):
  GH_TOKEN, CI_WEBHOOK_SECRET, DATABASE_URL, SOR_SIGNING_KEY, CI_WEBHOOK_PORT`);
}

function fail(message: string): never {
	console.error(`✗ ${message}`);
	process.exit(1);
}

const { command, force, foreground, repo, repoValid } = parseCliArgs(
	process.argv.slice(2),
);

switch (command) {
	case "init":
		await cliInit(force);
		break;
	case "enable": {
		if (repo === undefined || !repoValid) {
			fail("usage: self-healer enable --repo owner/repo");
		}
		await cliEnable(repo);
		break;
	}
	case "start":
		await cliStart(foreground);
		break;
	case "status":
		await cliStatus();
		break;
	case "help":
	case "--help":
	case "-h":
		printHelp();
		break;
	default:
		fail(`unknown command "${command}" (try 'self-healer help')`);
}
