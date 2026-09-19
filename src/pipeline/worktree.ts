// Standalone git worktree management (constitution v1.3.0 — direct
// `git worktree` shell calls, no Fleet import). Ported from Fleet's
// git/worktree.ts; only what the fix pipeline uses.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** Run git with argv (no shell). Returns stdout trimmed. */
async function git(args: string[], cwd?: string): Promise<string> {
	const { stdout } = await exec("git", args, {
		cwd,
		maxBuffer: 32 * 1024 * 1024,
	});
	return stdout.trim();
}

export interface WorktreeHandle {
	repoDir: string; // the clone used as the worktree source
	worktreeDir: string; // .runs/<id>/worktree — the ONLY place fixers edit
	branch: string;
	baseBranch: string;
}

/** Undo git's C-style quoting of a path (`git worktree list --porcelain`). */
function unquoteGitPath(s: string): string {
	if (!s.includes("\\")) return s;
	let out = "";
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (c !== "\\") {
			out += c;
		} else {
			const n = s[i + 1];
			if (n !== undefined && /[0-7]/.test(n)) {
				let v = 0;
				let j = i + 1;
				while (j < s.length && j < i + 4 && /[0-7]/.test(s[j] ?? "")) {
					v = v * 8 + (s.charCodeAt(j) - 48);
					j++;
				}
				out += String.fromCharCode(v);
				i = j - 1;
			} else {
				out += n ?? "\\";
				i++;
			}
		}
	}
	return out;
}

interface ListedWorktree {
	path: string;
	branch?: string;
}

/** Registered linked worktrees of `repoDir` (the clone's own tree is included). */
async function listWorktrees(repoDir: string): Promise<ListedWorktree[]> {
	const out = await git(["worktree", "list", "--porcelain"], repoDir);
	const worktrees: ListedWorktree[] = [];
	let current: ListedWorktree | null = null;
	for (const line of out.split("\n")) {
		if (line.startsWith("worktree ")) {
			if (current) worktrees.push(current);
			current = { path: unquoteGitPath(line.slice("worktree ".length)) };
		} else if (current && line.startsWith("branch ")) {
			current.branch = line.slice("branch ".length);
		}
	}
	if (current) worktrees.push(current);
	return worktrees;
}

/**
 * Remove stale linked worktrees a crashed/failed prior run left registered
 * against the reused clone. The clone's own working tree is never touched.
 */
async function removeStaleWorktrees(
	repoDir: string,
	worktreeDir: string,
	branch: string,
): Promise<void> {
	const branchRef = `refs/heads/${branch}`;
	let worktrees: ListedWorktree[];
	try {
		worktrees = await listWorktrees(repoDir);
	} catch (e) {
		console.warn(
			`[worktree] could not list registered worktrees (non-fatal): ${String(e)}`,
		);
		return;
	}
	const stale = worktrees.filter(
		(w) =>
			w.path !== repoDir &&
			w.path !== join(repoDir, ".") &&
			(w.path === worktreeDir ||
				w.path.startsWith(`${worktreeDir}/`) ||
				w.branch === branchRef),
	);
	for (const w of stale) {
		try {
			await git(["worktree", "remove", "--force", w.path], repoDir);
		} catch {
			await rm(w.path, { recursive: true, force: true }).catch(() => {});
		}
	}
}

/**
 * Refresh a reused session clone so a new run branches off the latest upstream
 * state, not the state left by the previous run. Best-effort throughout — a
 * flaky network never aborts the run.
 */
async function refreshReusedClone(
	repoDir: string,
	branch: string,
	worktreeDir: string,
): Promise<void> {
	try {
		await git(["fetch", "--quiet", "--prune", "origin"], repoDir);
	} catch (e) {
		console.warn(
			`[worktree] fetch of reused clone failed (non-fatal): ${String(e)}`,
		);
	}
	await removeStaleWorktrees(repoDir, worktreeDir, branch);
	try {
		await git(["worktree", "prune"], repoDir);
	} catch (e) {
		console.warn(`[worktree] worktree prune failed (non-fatal): ${String(e)}`);
	}
	try {
		const remoteHead = await git(
			["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"],
			repoDir,
		).catch(() => git(["rev-parse", "--abbrev-ref", "HEAD"], repoDir));
		const branchName = remoteHead.replace(/^refs\/remotes\/origin\//, "");
		await git(
			[
				"update-ref",
				`refs/heads/${branchName}`,
				`refs/remotes/origin/${branchName}`,
			],
			repoDir,
		);
	} catch (e) {
		console.warn(
			`[worktree] default-branch sync failed (non-fatal): ${String(e)}`,
		);
	}
	try {
		await git(["branch", "-D", branch], repoDir);
	} catch (e) {
		const err = e as { stderr?: string; message?: string };
		const msg = (err.stderr ?? err.message ?? String(e)).trim();
		if (/\bnot found\b|No such branch|does not exist/i.test(msg)) {
			// Branch never existed — nothing to delete.
		} else {
			console.warn(
				`[worktree] failed to drop stale branch "${branch}" (non-fatal): ${msg}`,
			);
		}
	}
}

/**
 * Prepare a run's linked git worktree. With no `existingRepoDir` this clones
 * `repoUrl` into `runDir/repo` and creates the fix branch in a linked worktree
 * at `runDir/worktree`. When `existingRepoDir` is provided the clone is
 * skipped: the session-level clone is fetched and a fresh worktree is linked.
 */
export async function setupWorktree(
	repoUrl: string,
	runDir: string,
	branch: string,
	existingRepoDir?: string,
	baseRef?: string,
): Promise<WorktreeHandle> {
	const repoDir = existingRepoDir ?? join(runDir, "repo");
	const worktreeDir = join(runDir, "worktree");
	await mkdir(runDir, { recursive: true });

	if (existingRepoDir) {
		await refreshReusedClone(existingRepoDir, branch, worktreeDir);
	} else {
		await git(["clone", "--quiet", repoUrl, repoDir]);
	}

	// Branch the fix worktree off the failing commit when supplied, so the
	// fixer operates on the exact tree that failed. Falls back to clone HEAD.
	const baseBranch =
		baseRef ??
		(await git(["rev-parse", "--abbrev-ref", "HEAD"], repoDir));

	// Fresh branch off the base, checked out in a linked worktree.
	await git(
		["worktree", "add", "-b", branch, worktreeDir, baseBranch],
		repoDir,
	);

	return { repoDir, worktreeDir, branch, baseBranch };
}

/** Remove the linked worktree (keeps the clone unless `full`). */
export async function cleanupWorktree(
	h: WorktreeHandle,
	full = false,
): Promise<void> {
	if (existsSync(h.worktreeDir)) {
		try {
			await git(["worktree", "remove", "--force", h.worktreeDir], h.repoDir);
		} catch {
			await rm(h.worktreeDir, { recursive: true, force: true });
		}
	}
	if (full && existsSync(h.repoDir)) {
		await rm(h.repoDir, { recursive: true, force: true });
	}
}