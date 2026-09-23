// `self-healer llm …` and `self-healer notes …` — operator tools for the
// AI agent's provider selection and learning notes.

import { loadConfig } from "../config.ts";
import { closePool, getPool } from "../db/pool.ts";
import { migrateUp } from "../db/migrate.ts";
import {
	createLlmClient,
	credentialsFromEnv,
	resolveLlm,
} from "../llm/resolve.ts";
import { addNote, listNotes, retireNote } from "../memory/notes.ts";
import { limitsFor, loadSettings, repoSettings } from "../settings.ts";

function fail(message: string): never {
	console.error(`✗ ${message}`);
	process.exit(1);
}

export async function cliLlm(
	sub: string | undefined,
	repo: string | undefined,
	repoValid: boolean,
): Promise<void> {
	if (sub !== "show" && sub !== "ping")
		fail("usage: self-healer llm show|ping [--repo owner/repo]");
	if (repo !== undefined && !repoValid)
		fail("--repo must look like owner/name");
	try {
		loadConfig();
	} catch {
		/* provider keys may still be set; required-var errors are irrelevant here */
	}
	const settings = loadSettings();
	const creds = credentialsFromEnv();
	const target = repo ?? "*/*";
	const choice = resolveLlm(settings, repo ?? "example/example", creds);
	console.log(
		`settings file : ${settings.source ?? "(none — defaults + env)"}`,
	);
	console.log(`repo          : ${repo ?? "(global default)"}`);
	console.log(`provider      : ${choice.provider}   (from ${choice.origin})`);
	console.log(`model         : ${choice.model}`);
	const limits = limitsFor(settings, repo ?? "example/example");
	console.log(
		`limits        : fix cycles ${limits.maxFixCycles}, model calls ${limits.maxLlmCalls}, tool calls ${limits.maxToolCalls}, time ${Math.round(limits.pipelineBudgetMs / 60000)}m, max files ${limits.maxFilesChanged - 1}`,
	);
	if (repo) {
		const rs = repoSettings(settings, repo);
		if (rs.testCommand) console.log(`test command  : ${rs.testCommand}`);
	}
	if (sub === "ping") {
		const client = createLlmClient(choice, creds);
		const t0 = Date.now();
		const res = await client.chat({
			system: "You are a health check.",
			messages: [{ role: "user", content: "Reply with the single word: ok" }],
			tools: [],
			maxOutputTokens: 16,
		});
		console.log(
			`ping (${target})  : "${res.text.trim().slice(0, 40)}" in ${Date.now() - t0}ms`,
		);
	}
}

export async function cliNotes(
	sub: string | undefined,
	o: {
		repo: string | undefined;
		repoValid: boolean;
		text: string | undefined;
		kind: string | undefined;
		id: string | undefined;
		all: boolean;
	},
): Promise<void> {
	if (sub !== "list" && sub !== "add" && sub !== "retire")
		fail("usage: self-healer notes list|add|retire ...");
	try {
		loadConfig();
	} catch (err) {
		fail(`configuration incomplete: ${String(err)}`);
	}
	migrateUp();
	const pool = getPool();
	try {
		if (sub === "list") {
			if (!o.repo || !o.repoValid)
				fail("usage: self-healer notes list --repo owner/repo [--all]");
			const notes = await listNotes(pool, o.repo, o.all);
			if (notes.length === 0) console.log(`(no notes for ${o.repo})`);
			for (const n of notes) {
				console.log(
					`${n.note_id.slice(0, 8)}  [${n.kind}] conf ${Number(n.confidence).toFixed(2)} used ${n.times_used}x reinforced ${n.reinforced}x ${n.status === "retired" ? "(retired) " : ""}${n.source}\n          ${n.body}${n.files ? `\n          files: ${n.files}` : ""}`,
				);
			}
		} else if (sub === "add") {
			if (!o.repo || !o.repoValid || !o.text)
				fail(
					'usage: self-healer notes add --repo owner/repo --text "..." [--kind gotcha]',
				);
			const r = await addNote(
				pool,
				{ repo: o.repo, source: "human" },
				{ kind: o.kind ?? "gotcha", text: o.text },
			);
			console.log(
				r
					? `✓ ${r.merged ? "merged into existing note" : "added"} ${r.id.slice(0, 8)}`
					: "✗ note too short or empty",
			);
		} else {
			if (!o.id)
				fail("usage: self-healer notes retire --id <note-id-or-prefix>");
			const rows = await pool.query<{ note_id: string }>(
				"SELECT note_id FROM repo_notes WHERE note_id LIKE $1 AND status = 'active'",
				[`${o.id}%`],
			);
			if (rows.rows.length !== 1)
				fail(
					rows.rows.length === 0
						? "no matching active note"
						: "id prefix is ambiguous",
				);
			await retireNote(pool, rows.rows[0]?.note_id ?? "");
			console.log("✓ retired");
		}
	} finally {
		await closePool();
	}
}
