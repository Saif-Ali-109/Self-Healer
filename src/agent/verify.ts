// Verification gate + diff guardrails. Nothing is pushed unless the FULL test
// suite (and any configured checks) passes in the worktree, regardless of the
// kind of bug — and the diff passes the anti-cheating guardrails below.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RepoSettings } from "../settings.ts";
import { runProcess, splitCommand, tailText } from "./sandbox.ts";

export interface Commands {
	install: string[] | null;
	test: string[] | null;
	extraChecks: string[][];
	/** How the commands were chosen (for the audit trail). */
	source: "config" | "detected" | "none";
}

const DEFAULT_NPM_TEST = /no test specified/i;

/** Decide install/test commands: repo config first, else detect from the tree. */
export function detectCommands(dir: string, cfg: RepoSettings = {}): Commands {
	const extraChecks = (cfg.verifyCommands ?? [])
		.map(splitCommand)
		.filter((a) => a.length > 0);
	const install =
		cfg.installCommand !== undefined
			? cfg.installCommand
				? splitCommand(cfg.installCommand)
				: null
			: undefined;
	if (cfg.testCommand) {
		return {
			install: install === undefined ? detectInstall(dir) : install,
			test: splitCommand(cfg.testCommand),
			extraChecks,
			source: "config",
		};
	}
	const test = detectTest(dir);
	return {
		install: install === undefined ? detectInstall(dir) : install,
		test,
		extraChecks,
		source: test ? "detected" : "none",
	};
}

function has(dir: string, f: string): boolean {
	return existsSync(join(dir, f));
}

function pkgManager(dir: string): "pnpm" | "yarn" | "npm" {
	if (has(dir, "pnpm-lock.yaml")) return "pnpm";
	if (has(dir, "yarn.lock")) return "yarn";
	return "npm";
}

function detectInstall(dir: string): string[] | null {
	if (has(dir, "package.json")) {
		const pm = pkgManager(dir);
		if (pm === "pnpm") return ["pnpm", "install", "--frozen-lockfile"];
		if (pm === "yarn") return ["yarn", "install", "--frozen-lockfile"];
		return has(dir, "package-lock.json") ? ["npm", "ci"] : ["npm", "install"];
	}
	return null; // python/go/rust: set installCommand in config if needed
}

function detectTest(dir: string): string[] | null {
	if (has(dir, "package.json")) {
		try {
			const pkg = JSON.parse(
				readFileSync(join(dir, "package.json"), "utf8"),
			) as { scripts?: Record<string, string> };
			const t = pkg.scripts?.test;
			if (t && !DEFAULT_NPM_TEST.test(t)) return [pkgManager(dir), "test"];
		} catch {
			/* fall through */
		}
	}
	if (has(dir, "go.mod")) return ["go", "test", "./..."];
	if (has(dir, "Cargo.toml")) return ["cargo", "test"];
	if (has(dir, "pytest.ini") || has(dir, "tox.ini") || has(dir, "conftest.py"))
		return ["python", "-m", "pytest", "-q"];
	if (
		has(dir, "pyproject.toml") &&
		/pytest/.test(readFileSync(join(dir, "pyproject.toml"), "utf8"))
	)
		return ["python", "-m", "pytest", "-q"];
	if (has(dir, "pom.xml")) return ["mvn", "-q", "test"];
	if (has(dir, "gradlew")) return ["./gradlew", "test"];
	return null;
}

export interface GateResult {
	passed: boolean;
	/** Human summary of what ran and how it ended. */
	summary: string;
	/** Tail of the failing command's output (empty when passed). */
	failureOutput: string;
	ranCommands: string[];
}

export interface GateOptions {
	cwd: string;
	env: Record<string, string>;
	timeoutMs: number;
	wrapper: string[];
}

/** Run test command then extra checks; stop at the first failure. */
export async function runGate(
	cmds: Commands,
	o: GateOptions,
): Promise<GateResult> {
	const ran: string[] = [];
	const all = [...(cmds.test ? [cmds.test] : []), ...cmds.extraChecks];
	if (all.length === 0) {
		return {
			passed: false,
			summary: "no test command available",
			failureOutput: "",
			ranCommands: [],
		};
	}
	for (const argv of all) {
		const label = argv.join(" ");
		ran.push(label);
		const r = await runProcess(argv, {
			cwd: o.cwd,
			env: o.env,
			timeoutMs: o.timeoutMs,
			wrapper: o.wrapper,
			maxOutputBytes: 512 * 1024,
		});
		if (r.timedOut) {
			return {
				passed: false,
				summary: `${label}: timed out after ${Math.round(o.timeoutMs / 1000)}s`,
				failureOutput: tailText(r.output, 6000),
				ranCommands: ran,
			};
		}
		if (r.code !== 0) {
			return {
				passed: false,
				summary: `${label}: exit ${r.code}`,
				failureOutput: tailText(r.output, 6000),
				ranCommands: ran,
			};
		}
	}
	return {
		passed: true,
		summary: `${ran.join(" && ")}: passed`,
		failureOutput: "",
		ranCommands: ran,
	};
}

// ── diff guardrails ──────────────────────────────────────────────────

export type GuardrailKind = "multi_file" | "guardrail_violation";

export interface GuardrailViolation {
	kind: GuardrailKind;
	message: string;
}

const TEST_FILE_RE =
	/(^|\/)(tests?|__tests__|specs?)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]+\.py$|_test\.(py|go)$|Tests?\.(java|cs|kt)$/;
const SKIP_MARKER_RE =
	/\b(it|test|describe)\.(skip|todo)\s*\(|\bx(it|describe|test)\s*\(|@pytest\.mark\.skip|@unittest\.skip|\bt\.Skip(Now)?\s*\(|#\[ignore\]|--passWithNoTests|\bpytest\.skip\s*\(|@Disabled\b|@Ignore\b/;
const SECRET_RE =
	/(gh[pous]_[A-Za-z0-9_]{30,}|github_pat_[A-Za-z0-9_]{40,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|sk-[A-Za-z0-9]{24,}|AIza[0-9A-Za-z_-]{30,})/;
const DEP_FILES =
	/(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|requirements[^/]*\.txt|pyproject\.toml|poetry\.lock|go\.mod|go\.sum|Cargo\.toml|Cargo\.lock|pom\.xml|build\.gradle)$/;

export interface DiffFile {
	status: string; // A | M | D | R...
	path: string;
}

export interface DiffInfo {
	files: DiffFile[];
	addedLines: string[];
	/** Sizes (bytes) of added/modified files, for the large-file check. */
	bigFiles: string[];
}

export function checkGuardrails(
	diff: DiffInfo,
	maxFiles: number,
): GuardrailViolation | null {
	if (diff.files.length === 0) {
		return {
			kind: "guardrail_violation",
			message:
				"the worktree has no changes — nothing to push. Make a real fix or call give_up.",
		};
	}
	if (diff.files.length >= maxFiles) {
		return {
			kind: "multi_file",
			message: `the fix touches ${diff.files.length} files (limit is ${maxFiles - 1}). Find a smaller, more targeted fix or call give_up.`,
		};
	}
	for (const f of diff.files) {
		if (f.path.startsWith(".github/") || f.path.startsWith(".git/"))
			return {
				kind: "guardrail_violation",
				message: `changes to ${f.path} are forbidden (CI config must not be edited to make CI pass).`,
			};
		if (f.path.startsWith("node_modules/"))
			return {
				kind: "guardrail_violation",
				message: `${f.path} is a dependency directory and must not be committed.`,
			};
		if (f.status.startsWith("D") && TEST_FILE_RE.test(f.path))
			return {
				kind: "guardrail_violation",
				message: `deleting test file ${f.path} is forbidden. Fix the code (or the test's actual bug) instead.`,
			};
	}
	if (diff.bigFiles.length > 0)
		return {
			kind: "guardrail_violation",
			message: `files over 1 MB must not be committed: ${diff.bigFiles.join(", ")}`,
		};
	for (const line of diff.addedLines) {
		if (SKIP_MARKER_RE.test(line))
			return {
				kind: "guardrail_violation",
				message: `the fix adds a test skip/disable marker (${line.trim().slice(0, 80)}). Skipping tests is not a fix.`,
			};
		if (SECRET_RE.test(line))
			return {
				kind: "guardrail_violation",
				message: "the diff appears to contain a credential/secret; remove it.",
			};
	}
	return null;
}

/** Non-blocking warnings shown in the CI comment for reviewers. */
export function diffWarnings(diff: DiffInfo): string[] {
	const w: string[] = [];
	const dep = diff.files
		.filter((f) => DEP_FILES.test(f.path))
		.map((f) => f.path);
	if (dep.length > 0)
		w.push(
			`Dependency manifest/lockfile changed (${dep.join(", ")}) — review supply-chain impact.`,
		);
	const testsTouched = diff.files
		.filter((f) => TEST_FILE_RE.test(f.path) && !f.status.startsWith("A"))
		.map((f) => f.path);
	if (testsTouched.length > 0)
		w.push(
			`Existing test files modified (${testsTouched.join(", ")}) — confirm the tests were wrong, not the code.`,
		);
	return w;
}
