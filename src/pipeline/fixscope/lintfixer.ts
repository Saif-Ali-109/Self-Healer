import { execFile } from "node:child_process";
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

export interface LintFixResult {
	success: boolean;
	diff: string;
	filesChanged: number;
	verificationOutput: string;
	error?: string;
}

/**
 * Run formatter in the worktree, verify (lint exits 0), commit + push.
 *
 * Steps:
 * 1. Run the fixer command (e.g. `npx @biomejs/biome check --write .`) in the worktree
 * 2. Check for a non-empty diff
 * 3. Run the verifier (linter again) — must exit 0
 * 4. Stage all changes, commit, push to origin/<branch>
 */
export async function applyLintFix(
	worktree: WorktreeHandle,
	branch: string,
	fixerCommand: string = "npx @biomejs/biome check --write .",
	verifierCommand: string = "npx @biomejs/biome check .",
): Promise<LintFixResult> {
	try {
		// Step 1: Apply the fixer
		const fixOutput = await exec(fixerCommand, {
			cwd: worktree.worktreeDir,
			shell: true,
		});
		console.log("[lintfixer] fixer output:", fixOutput.stdout?.slice(0, 500));

		// Step 2: Check for diff
		const diff = await git(["diff"], worktree.worktreeDir);
		const diffStat = await git(["diff", "--stat"], worktree.worktreeDir);
		const filesChanged = diffStat
			? diffStat
					.split("\n")
					.filter((l) => l.trim() && !l.includes("file"))[0]
					?.match(/(\d+)\s+file/)?.[1]
				? Number.parseInt(
						diffStat
							.split("\n")
							.find((l) => l.includes("files changed"))
							?.match(/(\d+)/)?.[0] ?? "0",
						10,
					)
				: diffStat.split("\n").length
			: 0;

		if (!diff || diff.trim() === "") {
			return {
				success: false,
				diff: "",
				filesChanged: 0,
				verificationOutput: "",
				error: "fixer produced no diff",
			};
		}

		// Step 3: Verify (linter must pass)
		let verifyOutput = "";
		try {
			const verifyResult = await exec(verifierCommand, {
				cwd: worktree.worktreeDir,
				shell: true,
			});
			verifyOutput = verifyResult.stdout ?? "";
		} catch (verifyErr) {
			// Verifier exited non-zero → fix didn't resolve the issue
			const err = verifyErr as { stdout?: string; stderr?: string };
			verifyOutput = (err.stdout ?? "") + (err.stderr ?? "");
			return {
				success: false,
				diff,
				filesChanged: 0,
				verificationOutput: verifyOutput,
				error: "verification failed",
			};
		}

		// Step 4: Commit + push
		await git(["add", "-A"], worktree.worktreeDir);
		await git(
			["commit", "-m", `fix: auto-format via self-healer (lint/format)`],
			worktree.worktreeDir,
		);
		await git(["push", "origin", branch], worktree.worktreeDir);

		const finalDiff = await git(
			["diff", "--stat", `${worktree.baseBranch}...HEAD`],
			worktree.worktreeDir,
		);

		return {
			success: true,
			diff: finalDiff || diff,
			filesChanged,
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
