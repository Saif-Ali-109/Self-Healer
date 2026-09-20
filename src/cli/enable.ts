// `self-healer enable --repo owner/repo` — opt a repository in:
// 1. Writes `.github/workflows/self-healer-notify.yml` (the reporter that posts
//    failures to the agent's webhook) on a `self-healer/enable` branch, via the
//    GitHub Contents API.
// 2. Opens a PR — the agent NEVER merges; a human reviews and merges it.
// 3. Records the repo in the SQLite `watched_repos` table so `status` lists it.

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { promisify } from "node:util";
import { loadConfig } from "../config.ts";
import { getPool, type Pool } from "../db/pool.ts";
import { packagePath } from "../paths.ts";

const exec = promisify(execFile);
const NOTIFY_TEMPLATE = packagePath("assets", "self-healer-notify.yml");

/** Run `gh <args>` and return trimmed stdout. Throws on non-zero exit. */
async function gh(args: string[]): Promise<string> {
	const { stdout } = await exec("gh", args, { maxBuffer: 16 * 1024 * 1024 });
	return stdout.trim();
}

export async function cliEnable(repo: string): Promise<void> {
	loadConfig(); // validates GH_TOKEN etc. (existence is the contract here)

	// 1. Repo must exist and be readable with the configured token.
	try {
		await gh(["api", `repos/${repo}`]);
	} catch {
		console.error(
			`✗ repo ${repo} not found or not accessible (check GH_TOKEN)`,
		);
		process.exit(1);
	}

	// 2. Default branch + its current head sha.
	const defaultBranch = await gh([
		"api",
		`repos/${repo}`,
		"--jq",
		".default_branch",
	]);
	const headSha = await gh([
		"api",
		`repos/${repo}/git/ref/heads/${defaultBranch}`,
		"--jq",
		".object.sha",
	]);

	// 3. Already enabled? Check the workflow file on the default branch.
	const filePath = ".github/workflows/self-healer-notify.yml";
	const existingContent = await gh([
		"api",
		`repos/${repo}/contents/${filePath}`,
		"--jq",
		".content",
	]).catch(() => "");
	if (existingContent) {
		const decoded = Buffer.from(existingContent, "base64").toString("utf8");
		if (decoded.includes("self-healer")) {
			await registerWatched(repo, defaultBranch, null);
			console.log(`✔ ${repo} already has ${filePath} — registered as watched`);
			return;
		}
	}

	if (!existsSync(NOTIFY_TEMPLATE)) {
		console.error("✗ reporter template missing from package");
		process.exit(1);
	}
	const content = readFileSync(NOTIFY_TEMPLATE, "utf8");
	const encoded = Buffer.from(content, "utf8").toString("base64");

	// 4. Branch + file commit.
	const branch = "self-healer/enable";
	await gh([
		"api",
		`repos/${repo}/git/refs`,
		"-f",
		"ref=refs/heads/self-healer/enable",
		"-f",
		`sha=${headSha}`,
	]);
	await gh([
		"api",
		`repos/${repo}/contents/${filePath}`,
		"-X",
		"PUT",
		"-f",
		`branch=${branch}`,
		"-f",
		"message=chore: enable self-healer CI agent",
		"-f",
		`content=${encoded}`,
	]);

	// 5. Open the PR (human merges).
	const body = [
		"This PR adds the `self-healer-notify` workflow: when a CI job fails, it",
		"posts the failure to the Self-Healer CI agent, which classifies it",
		"(flaky / real_bug / infra), retries flaky runs, and auto-fixes allowlisted",
		"bugs via fix-only PRs (which also require a human merge).",
		"",
		"Before merging: add the `SELF_HEALER_URL` and `CI_WEBHOOK_SECRET` repo secrets.",
	].join("\n");
	const prUrl = await gh([
		"pr",
		"create",
		"--repo",
		repo,
		"--base",
		defaultBranch,
		"--head",
		branch,
		"--title",
		"🤖 Enable Self-Healer CI agent",
		"--body",
		body,
		"--jq",
		".html_url",
	]);

	await registerWatched(repo, branch, prUrl);
	console.log(
		`✔ ${repo} enabled — reporter PR opened (human review required):`,
	);
	console.log(`  ${prUrl}`);
	console.log(
		`  Add secrets SELF_HEALER_URL + CI_WEBHOOK_SECRET to ${repo} before merging.`,
	);
	console.log(
		`  (The agent never merges; this repo becomes active when you merge the PR.)`,
	);
}

/** Upsert the repo into watched_repos. Exported for tests (pool injectable). */
export async function registerWatched(
	repo: string,
	branch: string,
	prUrl: string | null,
	pool: Pool = getPool(),
): Promise<void> {
	try {
		await pool.query(
			`INSERT INTO watched_repos (repo, added_at, workflow_branch, workflow_pr)
			 VALUES ($1, now(), $2, $3)
			 ON CONFLICT (repo) DO UPDATE SET
			   workflow_branch = EXCLUDED.workflow_branch,
			   workflow_pr = EXCLUDED.workflow_pr`,
			[repo, branch, prUrl],
		);
	} catch (err) {
		console.error("[enable] failed to record watched repo:", err);
	}
}
