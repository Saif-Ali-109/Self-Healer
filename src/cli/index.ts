// self-healer — CLI entry point (US6: install/enable/run the standalone agent).
// Usage:
//   self-healer init                  create .env + SQLite database
//   self-healer enable --repo o/r     write self-healer-notify.yml (PR) + register
//   self-healer start                 run the daemon (webhook :3457 + worker)
//   self-healer status                report db/queue/SOR/watch state

import { parseCliArgs } from "./args.ts";
import { cliEnable } from "./enable.ts";
import { cliInit } from "./init.ts";
import { cliLlm, cliNotes } from "./agent.ts";
import { cliStart } from "./start.ts";
import { cliStatus } from "./status.ts";
import { cliStop } from "./stop.ts";

function printHelp(): void {
	console.log(`self-healer — CI failure agent (standalone, node:sqlite)

Usage:
  self-healer init [--force]          create .env + SQLite database, then migrate
  self-healer enable --repo owner/repo
                                      write self-healer-notify.yml to the repo via a
                                      PR (never merged by the agent) + register watched
  self-healer start [--foreground]    run the daemon: webhook on :3457 + FIFO worker
                                      (default: detached, logs to data/self-healer.log)
  self-healer stop                    stop the daemon (reads data/self-healer.pid)
  self-healer status                  show database, pending queue, watched repos, SOR chain
  self-healer llm show [--repo o/r]   show which provider/model a repo will use (and why)
  self-healer llm ping [--repo o/r]   send one tiny request to that provider/model
  self-healer notes list --repo o/r [--all]
                                      show the agent's learned notes for a repo
  self-healer notes add --repo o/r --text "..." [--kind gotcha]
                                      teach the agent something (human notes rank highest)
  self-healer notes retire --id <note-id>
                                      stop using a note

Env (from .env — see .env.example):
  GH_TOKEN, CI_WEBHOOK_SECRET, DATABASE_URL, SOR_SIGNING_KEY, CI_WEBHOOK_PORT,
  GEMINI_API_KEY / OPENROUTER_API_KEY / OLLAMA_BASE_URL
Settings: self-healer.config.json (or $SELF_HEALER_CONFIG) — see self-healer.config.example.json`);
}

function fail(message: string): never {
	console.error(`✗ ${message}`);
	process.exit(1);
}

const cli = parseCliArgs(process.argv.slice(2));
const { command, force, foreground, repo, repoValid } = cli;

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
	case "stop":
		await cliStop();
		break;
	case "status":
		await cliStatus();
		break;
	case "llm":
		await cliLlm(cli.sub, repo, repoValid);
		break;
	case "notes":
		await cliNotes(cli.sub, {
			repo,
			repoValid,
			text: cli.flag("text"),
			kind: cli.flag("kind"),
			id: cli.flag("id"),
			all: process.argv.includes("--all"),
		});
		break;
	case "help":
	case "--help":
	case "-h":
		printHelp();
		break;
	default:
		fail(`unknown command "${command}" (try 'self-healer help')`);
}
