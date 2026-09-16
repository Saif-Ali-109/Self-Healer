// Deterministic missing-import fixer (import/type).
// Detection: `ReferenceError: X is not defined`. Fix: add the one import line
// for X, sourced from the single file that exports X, then re-run the failing
// command in the worktree (exit 0 verifies). ESM-only; CJS bails without
// editing. Pure detection/derivation helpers are exported for unit tests; the
// shell layer (`applyImportFix`) drives the worktree end-to-end.

import { execFile } from "node:child_process";
import {
	existsSync,
	readdirSync,
	readFileSync,
	type Stats,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, posix } from "node:path";
import { promisify } from "node:util";
import type { WorktreeHandle } from "../../../fleet/src/git/worktree.ts";

const exec = promisify(execFile);

async function git(args: string[], cwd?: string): Promise<string> {
	const { stdout } = await exec("git", args, {
		cwd,
		maxBuffer: 32 * 1024 * 1024,
	});
	return stdout.trim();
}

export interface ImportFixResult {
	success: boolean;
	diff: string;
	filesChanged: number;
	verificationOutput: string;
	error?: string;
	reason?: string; // guardrail bails (no_failing_file, cjs_not_supported, …)
}

export type ModuleSystem = "esm" | "cjs";

const VERIFY_TIMEOUT_MS = 60_000;

// ── Detection (pure) ─────────────────────────────────────────────────────

const REFERENCE_ERROR_RE =
	/ReferenceError:\s+([A-Za-z_$][A-Za-z0-9_$]*)\s+is not defined/;

/** Extract the undefined symbol from a ReferenceError line, if any. */
export function extractMissingSymbol(logText: string): string | undefined {
	return REFERENCE_ERROR_RE.exec(logText)?.[1];
}

/** GitHub Actions runner prefixes stripped so frames map to repo-relative paths. */
const RUNNER_ROOT_PREFIXES: ReadonlyArray<RegExp> = [
	/^\/home\/runner\/work\/[^/]+\/[^/]+\//,
	/^\/github\/workspace\//,
];

/**
 * Parse `at file:///…:line:col` stack frames out of a failure log, strip the
 * runner root prefix, and return worktree-relative candidate paths. Frames
 * into node internals are ignored.
 */
export function parseStackFrameCandidates(logText: string): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const line of logText.split("\n")) {
		if (line.includes("node:internal")) continue;
		const m = line.match(/file:\/\/([^\s)]+)/);
		if (!m?.[1]) continue;
		let path = m[1].replace(/:\d+:\d+$/, "");
		for (const prefix of RUNNER_ROOT_PREFIXES) {
			path = path.replace(prefix, "");
		}
		// Only keep paths that now map into the repo (a prefix was stripped).
		if (path && !path.startsWith("/") && !seen.has(path)) {
			seen.add(path);
			out.push(path);
		}
	}
	return out;
}

const SOURCE_EXTENSION_RE = /\.(?:mjs|cjs|js|mts|cts|ts|tsx|jsx)$/;

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * True when `source` references `symbol` as a bare token (not dot-qualified)
 * without importing or exporting it.
 */
function referencesSymbolExcludingImportsExports(
	source: string,
	symbol: string,
): boolean {
	const e = escapeRegExp(symbol);
	const bare = new RegExp(`(?<![.\\w])${e}\\b`);
	if (!bare.test(source)) return false;
	if (new RegExp(`\\bimport\\b[\\s\\S]{0,1000}?\\b${e}\\b`).test(source)) {
		return false;
	}
	if (new RegExp(`\\bexport\\b[\\s\\S]{0,1000}?\\b${e}\\b`).test(source)) {
		return false;
	}
	return true;
}

/**
 * Derive the failing file: validate stack-frame candidates in order (exists in
 * the worktree AND references the symbol without importing/exporting it), else
 * fall back to a worktree-wide bare-token usage search that must yield exactly
 * one hit. Returns the worktree-relative path or undefined.
 */
export function findFailingFile(
	worktreeDir: string,
	symbol: string,
	relCandidates: string[],
): string | undefined {
	const seen = new Set<string>();
	for (const cand of relCandidates) {
		if (seen.has(cand)) continue;
		seen.add(cand);
		const abs = join(worktreeDir, cand);
		if (!existsSync(abs) || !statSync(abs).isFile()) continue;
		const source = readFileSync(abs, "utf8");
		if (referencesSymbolExcludingImportsExports(source, symbol)) return cand;
	}
	return findLoneUsageFile(worktreeDir, symbol);
}

function findLoneUsageFile(
	worktreeDir: string,
	symbol: string,
): string | undefined {
	const hits: string[] = [];
	const walk = (dir: string): void => {
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}
		for (const name of entries) {
			if (name === ".git" || name === "node_modules") continue;
			const abs = join(dir, name);
			let st: Stats;
			try {
				st = statSync(abs);
			} catch {
				continue;
			}
			if (st.isDirectory()) {
				walk(abs);
				continue;
			}
			if (!SOURCE_EXTENSION_RE.test(name)) continue;
			const rel = posix.relative(worktreeDir, abs);
			if (rel.startsWith("node_modules")) continue;
			if (
				referencesSymbolExcludingImportsExports(
					readFileSync(abs, "utf8"),
					symbol,
				)
			) {
				hits.push(rel);
			}
		}
	};
	walk(worktreeDir);
	return hits.length === 1 ? hits[0] : undefined;
}

// ── Exporter derivation (pure) ───────────────────────────────────────────

export interface ExporterHit {
	file: string;
	exportName: string;
}

export type ExporterLookup =
	| { ok: true; exporter: ExporterHit }
	| { ok: false; reason: "no_exporter" | "multiple_exporters" };

const EXPORT_DECLARATION_RE =
	/\bexport\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;
const EXPORT_DEFAULT_FUNCTION_RE =
	/\bexport\s+default\s+(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;
const EXPORT_BLOCK_RE = /\bexport\s*\{([^}]*)\}/g;

/** Exported names within an `export { … }` block (aliases resolve to the imported name). */
function exportedNamesFromBlock(group: string): string[] {
	const names: string[] = [];
	for (const spec of group.split(",")) {
		const s = spec.trim();
		if (!s) continue;
		const m = s.match(
			/^([A-Za-z_$][A-Za-z0-9_$]*)(?:\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*))?$/,
		);
		if (!m) continue;
		names.push(m[2] ?? m[1]!);
	}
	return names;
}

/**
 * Locate the single file that exports `symbol`. Supports
 * `export function|const|let|var|class|async function S`, `export default
 * function S`, and `export { local as S }` alias forms. Type-only exports
 * (`export type/interface S`) and `export * from …` barrels are never counted.
 */
export function findExporter(
	worktreeDir: string,
	symbol: string,
): ExporterLookup {
	const files: string[] = [];
	const consider = (rel: string, source: string): void => {
		for (const re of [EXPORT_DECLARATION_RE, EXPORT_DEFAULT_FUNCTION_RE]) {
			for (const m of source.matchAll(re)) {
				if (m[1] === symbol) {
					files.push(rel);
					return;
				}
			}
		}
		for (const m of source.matchAll(EXPORT_BLOCK_RE)) {
			if (exportedNamesFromBlock(m[1] ?? "").includes(symbol)) {
				files.push(rel);
				return;
			}
		}
	};
	const walk = (dir: string): void => {
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}
		for (const name of entries) {
			if (name === ".git" || name === "node_modules") continue;
			const abs = join(dir, name);
			let st: Stats;
			try {
				st = statSync(abs);
			} catch {
				continue;
			}
			if (st.isDirectory()) {
				walk(abs);
				continue;
			}
			if (!SOURCE_EXTENSION_RE.test(name)) continue;
			const rel = posix.relative(worktreeDir, abs);
			if (rel.startsWith("node_modules")) continue;
			consider(rel, readFileSync(abs, "utf8"));
		}
	};
	walk(worktreeDir);

	if (files.length === 0) return { ok: false, reason: "no_exporter" };
	if (files.length > 1) return { ok: false, reason: "multiple_exporters" };
	const file = files[0]!;
	return { ok: true, exporter: { file, exportName: symbol } };
}

// ── Import-line construction (pure) ──────────────────────────────────────

/** One import line: `import { S } from "<specifier>";` */
export function buildImportLine(symbol: string, relSpecifier: string): string {
	return `import { ${symbol} } from "${relSpecifier}";`;
}

/** On-disk relative specifier (posix, leading `./`, extension preserved). */
export function buildRelSpecifier(fromFile: string, toFile: string): string {
	let rel = posix.relative(posix.dirname(fromFile), toFile);
	if (!rel.startsWith(".")) rel = `./${rel}`;
	return rel;
}

/** Insert the import at index 0 (after a shebang) with blank-line separation. */
export function insertImportAtTop(source: string, importLine: string): string {
	const lines = source.split("\n");
	const insertAt = (lines[0] ?? "").startsWith("#!") ? 1 : 0;
	lines.splice(insertAt, 0, importLine, "");
	return lines.join("\n");
}

// ── Module-system detection (pure) ───────────────────────────────────────

/** "type" of the nearest package.json walking up from the file ("module" | null | undefined). */
function nearestPackageType(absFilePath: string): "module" | null | undefined {
	let dir = dirname(absFilePath);
	for (;;) {
		const pkgPath = join(dir, "package.json");
		if (existsSync(pkgPath)) {
			try {
				const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
					type?: unknown;
				};
				return pkg.type === "module" ? "module" : null;
			} catch {
				return null;
			}
		}
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

/**
 * Module system of a file, by precedence: .mjs/.cjs extension → nearest
 * package.json "type" (any existing package.json without "type" is CJS by Node
 * default) → syntax sniff (import/export vs require/module.exports) → CJS.
 */
export function detectModuleSystem(
	worktreeDir: string,
	file: string,
): ModuleSystem {
	if (file.endsWith(".mjs")) return "esm";
	if (file.endsWith(".cjs")) return "cjs";
	const pkgType = nearestPackageType(join(worktreeDir, file));
	if (pkgType === "module") return "esm";
	if (pkgType === null) return "cjs";
	const source = readFileSync(join(worktreeDir, file), "utf8");
	if (/\bimport\b|\bexport\b/.test(source)) return "esm";
	if (/\brequire\s*\(|module\.exports/.test(source)) return "cjs";
	return "cjs"; // Node default when nothing says otherwise
}

// ── Shell layer (worktree end-to-end) ────────────────────────────────────

async function onlyChangedFile(
	worktreeDir: string,
	expected: string,
): Promise<boolean> {
	const names = (await git(["diff", "--name-only"], worktreeDir))
		.split("\n")
		.filter((l) => l.trim());
	return names.length === 1 && names[0] === expected;
}

function countChangedFiles(stat: string): number {
	if (!stat) return 0;
	const m = stat.match(/(\d+)\s+file/);
	return m ? Number.parseInt(m[1] ?? "0", 10) : 0;
}

/**
 * Fix a missing import in the worktree:
 * 1. Derive symbol → failing file (stack frames, then lone-usage fallback)
 * 2. Bail without editing when the file is CommonJS
 * 3. Derive the exporter → build `import { S } from "<specifier>";`
 * 4. Insert at the top; guardrail: exactly one file changed
 * 5. Verify by executing `verifyCommand` in the worktree — must exit 0
 * 6. Commit `fix: add missing import (import/type)` and push origin/<branch>
 */
export async function applyImportFix(
	worktree: WorktreeHandle,
	branch: string,
	verifyCommand: string,
	logText: string,
): Promise<ImportFixResult> {
	try {
		const symbol = extractMissingSymbol(logText);
		if (!symbol) {
			return {
				success: false,
				diff: "",
				filesChanged: 0,
				verificationOutput: "",
				error: "no reference-error symbol found in the failure log",
			};
		}

		const relCandidates = parseStackFrameCandidates(logText);
		const failingFile = findFailingFile(
			worktree.worktreeDir,
			symbol,
			relCandidates,
		);
		if (!failingFile) {
			return {
				success: false,
				diff: "",
				filesChanged: 0,
				verificationOutput: "",
				reason: "no_failing_file",
			};
		}

		if (detectModuleSystem(worktree.worktreeDir, failingFile) === "cjs") {
			return {
				success: false,
				diff: "",
				filesChanged: 0,
				verificationOutput: "",
				reason: "cjs_not_supported",
			};
		}

		const lookup = findExporter(worktree.worktreeDir, symbol);
		if (!lookup.ok) {
			return {
				success: false,
				diff: "",
				filesChanged: 0,
				verificationOutput: "",
				reason: lookup.reason,
			};
		}

		// Apply the one-line fix.
		const specifier = buildRelSpecifier(failingFile, lookup.exporter.file);
		const importLine = buildImportLine(symbol, specifier);
		const failingFileAbs = join(worktree.worktreeDir, failingFile);
		const source = readFileSync(failingFileAbs, "utf8");
		writeFileSync(
			failingFileAbs,
			insertImportAtTop(source, importLine),
			"utf8",
		);

		// Guardrail: exactly the one failing file changed.
		if (!(await onlyChangedFile(worktree.worktreeDir, failingFile))) {
			return {
				success: false,
				diff: await git(["diff"], worktree.worktreeDir),
				filesChanged: 0,
				verificationOutput: "",
				reason: "diff_guardrail",
			};
		}

		// Verify: the failing command must exit 0 in the worktree.
		let verifyOutput = "";
		try {
			const verifyResult = await exec(verifyCommand, {
				cwd: worktree.worktreeDir,
				shell: true,
				timeout: VERIFY_TIMEOUT_MS,
			});
			verifyOutput = verifyResult.stdout ?? "";
		} catch (verifyErr) {
			const err = verifyErr as {
				stdout?: string;
				stderr?: string;
				message?: string;
			};
			verifyOutput =
				(err.stdout ?? "") + (err.stderr ?? "") ||
				String(verifyErr instanceof Error ? verifyErr.message : verifyErr);
			return {
				success: false,
				diff: await git(["diff"], worktree.worktreeDir),
				filesChanged: 0,
				verificationOutput: verifyOutput,
				error: "verification failed",
			};
		}

		// Re-check before committing: the verify command must not have touched
		// anything beyond the one failing file.
		if (!(await onlyChangedFile(worktree.worktreeDir, failingFile))) {
			return {
				success: false,
				diff: await git(["diff"], worktree.worktreeDir),
				filesChanged: 0,
				verificationOutput: verifyOutput,
				reason: "diff_guardrail",
			};
		}

		await git(["add", "-A"], worktree.worktreeDir);
		await git(
			["commit", "-m", "fix: add missing import (import/type)"],
			worktree.worktreeDir,
		);
		await git(["push", "origin", branch], worktree.worktreeDir);

		const finalDiff = await git(
			["diff", "--stat", `${worktree.baseBranch}...HEAD`],
			worktree.worktreeDir,
		);

		return {
			success: true,
			diff: finalDiff,
			filesChanged: countChangedFiles(finalDiff),
			verificationOutput: verifyOutput,
		};
	} catch (err) {
		return {
			success: false,
			diff: "",
			filesChanged: 0,
			verificationOutput: "",
			error: String(err instanceof Error ? err.message : err),
		};
	}
}
