// Process + path sandboxing for everything the agent does inside a worktree.
//
// What this DOES: confines file tools to the worktree (realpath-checked),
// blocks writes to .git/ and .github/, runs repo commands WITHOUT a shell,
// with a scrubbed environment (no GH_TOKEN / API keys), a private HOME, a
// timeout, and an output cap.
// What this does NOT do: it is not an OS sandbox. Repo test code runs as the
// service user. For untrusted contributors, set agent.commandWrapper (e.g.
// bubblewrap) and run the service as a dedicated unprivileged user — see
// docs/DEPLOYMENT.md.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export class SandboxError extends Error {}

/** Resolve `p` inside `root`; throws if it escapes (incl. via symlinks). */
export function resolveInside(root: string, p: string): string {
	if (p.includes("\0")) throw new SandboxError("invalid path");
	const realRoot = realpathSync(root);
	const abs = resolve(realRoot, isAbsolute(p) ? relative(realRoot, p) : p);
	const rel = relative(realRoot, abs);
	if (rel.startsWith("..") || isAbsolute(rel))
		throw new SandboxError(`path escapes the worktree: ${p}`);
	// Follow symlinks for the deepest existing ancestor.
	let probe = abs;
	while (!existsSync(probe)) {
		const parent = resolve(probe, "..");
		if (parent === probe) break;
		probe = parent;
	}
	if (existsSync(probe)) {
		const realProbe = realpathSync(probe);
		const r = relative(realRoot, realProbe);
		if (r.startsWith("..") || isAbsolute(r))
			throw new SandboxError(`path escapes the worktree via symlink: ${p}`);
	}
	return abs;
}

export function relPath(root: string, abs: string): string {
	return relative(realpathSync(root), abs).split(sep).join("/");
}

/** Paths the agent may never write (it must not rewrite CI to make CI pass). */
export function isProtectedWritePath(rel: string): boolean {
	const p = rel.replace(/^\.\//, "");
	return (
		p === ".git" ||
		p.startsWith(".git/") ||
		p.startsWith(".github/") ||
		p.startsWith("node_modules/")
	);
}

// ── command policy ───────────────────────────────────────────────────

const ALLOWED_BINARIES = new Set([
	"npm",
	"npx",
	"pnpm",
	"yarn",
	"node",
	"tsc",
	"vitest",
	"jest",
	"eslint",
	"prettier",
	"biome",
	"bun",
	"deno",
	"pytest",
	"python",
	"python3",
	"pip",
	"pip3",
	"ruff",
	"mypy",
	"black",
	"uv",
	"poetry",
	"go",
	"gofmt",
	"cargo",
	"rustc",
	"rustfmt",
	"make",
	"mvn",
	"gradle",
	"dotnet",
	"bundle",
	"rspec",
	"rake",
	"php",
	"composer",
	"git",
]);
const GIT_READ_ONLY = new Set([
	"status",
	"diff",
	"log",
	"show",
	"ls-files",
	"blame",
	"rev-parse",
	"grep",
]);
const NPM_FORBIDDEN = new Set([
	"publish",
	"login",
	"logout",
	"adduser",
	"token",
	"whoami",
	"owner",
	"access",
	"exec",
	"dlx",
	"config",
	"set",
	"unpublish",
	"deprecate",
	"team",
	"org",
	"profile",
]);

/** Split a command line into argv (quotes + backslashes only; there is NO shell). */
export function splitCommand(cmd: string): string[] {
	const out: string[] = [];
	let cur = "";
	let quote: '"' | "'" | null = null;
	let has = false;
	for (let i = 0; i < cmd.length; i++) {
		const c = cmd[i] as string;
		if (quote) {
			if (c === quote) quote = null;
			else if (c === "\\" && quote === '"' && i + 1 < cmd.length)
				cur += cmd[++i];
			else cur += c;
		} else if (c === '"' || c === "'") {
			quote = c;
			has = true;
		} else if (/\s/.test(c)) {
			if (has || cur) out.push(cur);
			cur = "";
			has = false;
		} else if (c === "\\" && i + 1 < cmd.length) {
			cur += cmd[++i];
			has = true;
		} else {
			cur += c;
			has = true;
		}
	}
	if (quote) throw new SandboxError("unterminated quote in command");
	if (has || cur) out.push(cur);
	return out;
}

const SHELL_TOKENS = new Set([
	"&&",
	"||",
	"|",
	";",
	">",
	">>",
	"<",
	"&",
	"2>&1",
]);

/** Validate an agent-supplied command; returns argv to execute. */
export function checkAgentCommand(cmd: string): string[] {
	const argv = splitCommand(cmd);
	const bin = argv[0];
	if (!bin) throw new SandboxError("empty command");
	if (argv.some((a) => SHELL_TOKENS.has(a)))
		throw new SandboxError(
			"there is no shell: pipes, &&, ;, and redirects are not supported — run one command per call",
		);
	if (bin.includes("/") || !ALLOWED_BINARIES.has(bin))
		throw new SandboxError(
			`command "${bin}" is not allowed. Allowed: ${[...ALLOWED_BINARIES].sort().join(", ")}`,
		);
	const sub = argv.slice(1).find((a) => !a.startsWith("-"));
	if (bin === "git" && (!sub || !GIT_READ_ONLY.has(sub)))
		throw new SandboxError(
			`git is read-only here (allowed: ${[...GIT_READ_ONLY].join(", ")}); the harness commits and pushes`,
		);
	if (
		(bin === "npm" || bin === "pnpm" || bin === "yarn") &&
		sub &&
		NPM_FORBIDDEN.has(sub)
	)
		throw new SandboxError(`${bin} ${sub} is not allowed`);
	if (bin === "npx") {
		// Never download-and-run arbitrary packages: only what is already installed.
		if (!argv.includes("--no-install") && !argv.includes("--no"))
			argv.splice(1, 0, "--no-install");
	}
	return argv;
}

// ── running processes ────────────────────────────────────────────────

export interface RunResult {
	code: number | null;
	output: string;
	timedOut: boolean;
	truncated: boolean;
	durationMs: number;
}

export interface SandboxEnvOptions {
	runDir: string;
	cacheDir: string;
	extra?: Record<string, string>;
}

/** Minimal, secret-free environment for repo commands. */
export function scrubbedEnv(o: SandboxEnvOptions): Record<string, string> {
	const home = join(o.runDir, "home");
	mkdirSync(home, { recursive: true });
	mkdirSync(o.cacheDir, { recursive: true });
	const env: Record<string, string> = {
		PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
		HOME: home,
		LANG: process.env.LANG ?? "C.UTF-8",
		TZ: process.env.TZ ?? "UTC",
		CI: "true",
		NO_COLOR: "1",
		FORCE_COLOR: "0",
		npm_config_cache: join(o.cacheDir, "npm"),
		npm_config_update_notifier: "false",
		npm_config_fund: "false",
		npm_config_audit: "false",
		XDG_CACHE_HOME: o.cacheDir,
		PIP_CACHE_DIR: join(o.cacheDir, "pip"),
		PIP_DISABLE_PIP_VERSION_CHECK: "1",
		GOCACHE: join(o.cacheDir, "go-build"),
		GOPATH: join(o.cacheDir, "gopath"),
		CARGO_HOME: join(o.cacheDir, "cargo"),
		PYTHONDONTWRITEBYTECODE: "1",
	};
	if (process.env.RUSTUP_HOME) env.RUSTUP_HOME = process.env.RUSTUP_HOME;
	return { ...env, ...(o.extra ?? {}) };
}

export interface RunOptions {
	cwd: string;
	env: Record<string, string>;
	timeoutMs: number;
	maxOutputBytes?: number;
	wrapper?: string[];
}

/** Run argv (no shell). Output = stdout+stderr interleaved, tail-truncated. */
export function runProcess(argv: string[], o: RunOptions): Promise<RunResult> {
	const started = Date.now();
	const full = [...(o.wrapper ?? []), ...argv];
	const [bin, ...args] = full;
	const cap = o.maxOutputBytes ?? 256 * 1024;
	return new Promise((resolvePromise) => {
		let output = "";
		let truncated = false;
		let timedOut = false;
		let settled = false;
		const child = spawn(bin as string, args, {
			cwd: o.cwd,
			env: o.env,
			detached: true, // own process group so a timeout kills the whole tree
			stdio: ["ignore", "pipe", "pipe"],
		});
		const onData = (b: Buffer): void => {
			output += b.toString("utf8");
			if (output.length > cap * 2) {
				output = output.slice(-cap);
				truncated = true;
			}
		};
		child.stdout.on("data", onData);
		child.stderr.on("data", onData);
		const killTree = (): void => {
			try {
				if (child.pid) process.kill(-child.pid, "SIGKILL");
			} catch {
				/* already gone */
			}
		};
		const timer = setTimeout(() => {
			timedOut = true;
			killTree();
		}, o.timeoutMs);
		const finish = (code: number | null, extra = ""): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (output.length > cap) {
				output = output.slice(-cap);
				truncated = true;
			}
			resolvePromise({
				code,
				output: output + extra,
				timedOut,
				truncated,
				durationMs: Date.now() - started,
			});
		};
		child.on("error", (err) => finish(127, `\n[spawn error] ${err.message}`));
		child.on("close", (code) => finish(code));
	});
}

/** Keep the tail of long output (errors are almost always at the end). */
export function tailText(s: string, maxChars: number): string {
	if (s.length <= maxChars) return s;
	return `[… ${s.length - maxChars} earlier chars omitted …]\n${s.slice(-maxChars)}`;
}
