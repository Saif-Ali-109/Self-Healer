// Integration tests for applyImportFix: fixture repo + local bare remote,
// exercising the worktree end-to-end (fix → guardrail → verify → commit →
// push). Vitest-style mirror of tests/integration/lintfix_test.ts.

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import type { WorktreeHandle } from "../../fleet/src/git/worktree.ts";
import { applyImportFix } from "../../src/pipeline/fixscope/importfixer.ts";

const exec = promisify(execFile);

const tempRoots: string[] = [];

async function git(args: string[], cwd: string): Promise<string> {
	const { stdout } = await exec("git", args, { cwd });
	return stdout.trim();
}

/** Fixture repo: worktree with `origin` pointing at a local bare remote. */
async function makeRepo(
	files: Record<string, string>,
	branch = "main",
): Promise<{ root: string; worktreeDir: string; bareDir: string }> {
	const root = await mkdtemp(join(tmpdir(), "importfix-integration-"));
	const worktreeDir = join(root, "worktree");
	const bareDir = join(root, "origin.git");
	tempRoots.push(root);
	await exec("git", ["init", "--bare", "-q", bareDir]);
	await exec("git", ["init", "-q", "-b", branch, worktreeDir]);
	await exec("git", ["config", "user.email", "ci-bot@example.com"], {
		cwd: worktreeDir,
	});
	await exec("git", ["config", "user.name", "Self-Healer Bot"], {
		cwd: worktreeDir,
	});
	await exec("git", ["remote", "add", "origin", bareDir], {
		cwd: worktreeDir,
	});
	for (const [rel, content] of Object.entries(files)) {
		const abs = join(worktreeDir, rel);
		await mkdir(dirname(abs), { recursive: true });
		await writeFile(abs, content, "utf8");
	}
	await git(["add", "-A"], worktreeDir);
	await git(["commit", "-q", "-m", "fixture"], worktreeDir);
	await git(["push", "-q", "-u", "origin", branch], worktreeDir);
	return { root, worktreeDir, bareDir };
}

function makeHandle(
	worktreeDir: string,
	branch: string,
	baseBranch: string,
): WorktreeHandle {
	return { repoDir: worktreeDir, worktreeDir, branch, baseBranch };
}

const ESM_LOG = [
	"##[error]ReferenceError: renderWidget is not defined",
	"    at file:///home/runner/work/demo-repo/demo-repo/src/main.mjs:3:1",
	"    at ModuleJob.run (node:internal/modules/esm/module_job:271:25)",
].join("\n");

afterAll(async () => {
	for (const root of tempRoots.splice(0)) {
		await rm(root, { recursive: true, force: true }).catch(() => {});
	}
});

describe("applyImportFix", () => {
	it("fixes the missing import in an ESM fixture, verifies with node, commits and pushes", {
		timeout: 30_000,
	}, async () => {
		const { worktreeDir, bareDir } = await makeRepo({
			"src/renderer.mjs":
				'export function renderWidget() {\n  return "<widget>";\n}\n',
			"src/main.mjs":
				"const element = renderWidget();\nconsole.log(element);\n",
		});
		// The worktree starts at the failing state: node src/main.mjs crashes.
		await expect(
			exec("node", ["src/main.mjs"], { cwd: worktreeDir }),
		).rejects.toThrow(/renderWidget is not defined/);

		const branch = "ci-fix/abc12345";
		await git(["checkout", "-q", "-b", branch], worktreeDir);

		const result = await applyImportFix(
			makeHandle(worktreeDir, branch, "main"),
			branch,
			"node src/main.mjs",
			ESM_LOG,
		);

		expect(result.success).toBe(true);
		expect(result.reason).toBeUndefined();
		expect(result.filesChanged).toBe(1);
		expect(result.diff).toContain("1 file changed");

		// The fix: one import line at the very top.
		const fixed = await readFile(join(worktreeDir, "src/main.mjs"), "utf8");
		expect(
			fixed.startsWith('import { renderWidget } from "./renderer.mjs";\n'),
		).toBe(true);

		// The verifier actually ran and printed the rendered widget.
		expect(result.verificationOutput).toContain("<widget>");

		// Push happened: the bare remote holds refs/heads/<branch>.
		const remoteRefs = await exec("git", [
			"ls-remote",
			bareDir,
			`refs/heads/${branch}`,
		]);
		expect(remoteRefs.stdout).toContain(`refs/heads/${branch}`);

		// Exactly one commit on the fix branch (the fixture commit is on main).
		const depth = await git(
			["rev-list", "--count", `main..${branch}`],
			worktreeDir,
		);
		expect(depth).toBe("1");
	});

	it("bails with cjs_not_supported on a CommonJS fixture and modifies nothing", {
		timeout: 30_000,
	}, async () => {
		const { worktreeDir, bareDir } = await makeRepo({
			"src/renderer.cjs":
				'function renderWidget() {\n  return "<widget>";\n}\nmodule.exports = { renderWidget };\n',
			"src/main.cjs":
				"const element = renderWidget();\nconsole.log(element);\n",
		});
		const branch = "ci-fix/def67890";
		await git(["checkout", "-q", "-b", branch], worktreeDir);

		const log = ESM_LOG.replace("src/main.mjs", "src/main.cjs");
		const result = await applyImportFix(
			makeHandle(worktreeDir, branch, "main"),
			branch,
			"node src/main.cjs",
			log,
		);

		expect(result.success).toBe(false);
		expect(result.reason).toBe("cjs_not_supported");
		expect(result.diff).toBe("");

		// No file modified, nothing committed, nothing pushed.
		const names = (await git(["diff", "--name-only"], worktreeDir)).trim();
		expect(names).toBe("");
		const depth = await git(
			["rev-list", "--count", `main..${branch}`],
			worktreeDir,
		);
		expect(depth).toBe("0");
		const remoteRefs = await exec("git", [
			"ls-remote",
			bareDir,
			`refs/heads/${branch}`,
		]);
		expect(remoteRefs.stdout.trim()).toBe("");
	});
});
