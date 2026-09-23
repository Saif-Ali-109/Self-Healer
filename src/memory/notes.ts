// Persistent per-repo learning notes ("notes for himself").
//
// Written by the agent (via finish/give_up) and by the pipeline itself
// (flaky outcomes, escalations). Read before every fix so the agent starts
// warm instead of cold. Retrieval is keyword-scored in TypeScript — zero
// extra SQLite extensions, portable, and inspectable.
//
// Notes are DATA, not instructions: they can be derived from untrusted repo
// content, so the prompt presents them as hints and they are length-capped,
// secret-redacted, and decay when a fix built on them fails.

import type { Pool } from "../db/pool.ts";
import { redactSecrets } from "../pipeline/comments.ts";

export type NoteSource = "agent" | "system" | "human";

export interface NoteInput {
	kind: string;
	text: string;
	tags?: string[] | undefined;
	files?: string[] | undefined;
}

export interface StoredNote {
	note_id: string;
	repo: string;
	kind: string;
	body: string;
	tags: string;
	files: string;
	source_run_id: string | null;
	source: string;
	confidence: number;
	reinforced: number;
	times_used: number;
	status: string;
	created_at: number;
	last_used_at: number | null;
}

const KINDS = new Set([
	"flaky_hint",
	"root_cause",
	"fix_recipe",
	"gotcha",
	"avoid",
	"test_info",
	"run_outcome",
]);
const ALWAYS_RELEVANT = new Set(["gotcha", "test_info", "avoid"]);
const MAX_ACTIVE_PER_REPO = 300;
const MAX_BODY = 300;

const STOP = new Set([
	"the",
	"and",
	"for",
	"with",
	"that",
	"this",
	"from",
	"are",
	"was",
	"not",
	"but",
	"you",
	"all",
	"can",
	"has",
	"have",
	"its",
	"into",
	"when",
	"then",
	"than",
	"usually",
	"always",
	"error",
	"test",
	"tests",
	"file",
	"files",
	"run",
	"runs",
	"fail",
	"failed",
	"failing",
	"failure",
]);

export function tokenize(text: string): Set<string> {
	const out = new Set<string>();
	for (const raw of text.toLowerCase().split(/[^a-z0-9_./-]+/)) {
		if (!raw) continue;
		for (const part of [raw, ...raw.split(/[/.\-_]/)]) {
			if (part.length >= 3 && !STOP.has(part)) out.add(part);
		}
	}
	return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 || b.size === 0) return 0;
	let inter = 0;
	for (const x of a) if (b.has(x)) inter++;
	return inter / (a.size + b.size - inter);
}

export function sanitizeNote(input: NoteInput): {
	kind: string;
	body: string;
	tags: string[];
	files: string[];
} | null {
	const kind = KINDS.has(input.kind) ? input.kind : "gotcha";
	// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars on purpose
	const body = redactSecrets(String(input.text ?? ""))
		.replace(/[\u0000-\u001f\u007f]+/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, MAX_BODY);
	if (body.length < 8) return null;
	const tags = [
		...new Set(
			(input.tags ?? [])
				.map((t) =>
					String(t)
						.toLowerCase()
						.replace(/[^a-z0-9._/-]/g, ""),
				)
				.filter((t) => t.length >= 2),
		),
	].slice(0, 8);
	const files = [
		...new Set(
			(input.files ?? [])
				.map((f) => String(f).trim())
				.filter(
					(f) => f && !f.includes("..") && !f.startsWith("/") && f.length < 200,
				),
		),
	].slice(0, 5);
	return { kind, body, tags, files };
}

export async function addNote(
	pool: Pool,
	ctx: {
		repo: string;
		runId?: string | undefined;
		source: NoteSource;
		confidence?: number;
	},
	input: NoteInput,
): Promise<{ id: string; merged: boolean } | null> {
	const n = sanitizeNote(input);
	if (!n) return null;
	const existing = await pool.query<StoredNote>(
		"SELECT * FROM repo_notes WHERE repo = $1 AND kind = $2 AND status = 'active'",
		[ctx.repo, n.kind],
	);
	const mine = tokenize(`${n.body} ${n.tags.join(" ")}`);
	for (const e of existing.rows) {
		if (jaccard(mine, tokenize(`${e.body} ${e.tags}`)) >= 0.6) {
			const tags = [
				...new Set([...e.tags.split(" ").filter(Boolean), ...n.tags]),
			]
				.slice(0, 8)
				.join(" ");
			const files = [
				...new Set([...e.files.split(" ").filter(Boolean), ...n.files]),
			]
				.slice(0, 5)
				.join(" ");
			await pool.query(
				"UPDATE repo_notes SET reinforced = reinforced + 1, confidence = MIN(1.0, confidence + 0.1), tags = $1, files = $2 WHERE note_id = $3",
				[tags, files, e.note_id],
			);
			return { id: e.note_id, merged: true };
		}
	}
	const res = await pool.query<{ note_id: string }>(
		`INSERT INTO repo_notes (repo, kind, body, tags, files, source_run_id, source, confidence, created_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now()) RETURNING note_id`,
		[
			ctx.repo,
			n.kind,
			n.body,
			n.tags.join(" "),
			n.files.join(" "),
			ctx.runId ?? null,
			ctx.source,
			ctx.confidence ?? (ctx.source === "human" ? 0.95 : 0.6),
		],
	);
	await pruneNotes(pool, ctx.repo);
	return { id: res.rows[0]?.note_id ?? "", merged: false };
}

async function pruneNotes(pool: Pool, repo: string): Promise<void> {
	const c = await pool.query<{ n: number }>(
		"SELECT COUNT(*) AS n FROM repo_notes WHERE repo = $1 AND status = 'active'",
		[repo],
	);
	const excess = Number(c.rows[0]?.n ?? 0) - MAX_ACTIVE_PER_REPO;
	if (excess <= 0) return;
	await pool.query(
		`UPDATE repo_notes SET status = 'retired' WHERE note_id IN (
		   SELECT note_id FROM repo_notes WHERE repo = $1 AND status = 'active' AND source != 'human'
		   ORDER BY confidence * (1 + reinforced) ASC, created_at ASC LIMIT $2)`,
		[repo, excess],
	);
}

export interface RetrieveOptions {
	limit?: number;
	maxChars?: number;
}

/** Pull the notes most relevant to `queryText` (log excerpt, job name, paths). Marks them used. */
export async function retrieveNotes(
	pool: Pool,
	repo: string,
	queryText: string,
	opts: RetrieveOptions = {},
): Promise<StoredNote[]> {
	const limit = opts.limit ?? 8;
	const maxChars = opts.maxChars ?? 2500;
	const rows = await pool.query<StoredNote>(
		"SELECT * FROM repo_notes WHERE repo = $1 AND status = 'active'",
		[repo],
	);
	if (rows.rows.length === 0) return [];
	const q = tokenize(queryText);
	const qLower = queryText.toLowerCase();
	const now = Date.now();
	const scored = rows.rows.map((n) => {
		let s = 0;
		for (const f of n.files.split(" ").filter(Boolean))
			if (qLower.includes(f.toLowerCase())) s += 3;
		for (const t of n.tags.split(" ").filter(Boolean)) if (q.has(t)) s += 1;
		for (const t of tokenize(n.body)) if (q.has(t)) s += 0.3;
		if (s === 0 && ALWAYS_RELEVANT.has(n.kind)) s = 0.5;
		const ageDays = (now - Number(n.created_at)) / 86_400_000;
		const recency = 1 / (1 + ageDays / 90);
		return {
			n,
			score:
				s *
				Number(n.confidence) *
				(0.6 + 0.4 * recency) *
				(1 + Math.min(n.reinforced, 5) * 0.1),
		};
	});
	const picked: StoredNote[] = [];
	let chars = 0;
	for (const { n, score } of scored
		.filter((x) => x.score >= 0.25)
		.sort((a, b) => b.score - a.score)) {
		if (picked.length >= limit || chars + n.body.length > maxChars) break;
		picked.push(n);
		chars += n.body.length;
	}
	for (const n of picked) {
		await pool.query(
			"UPDATE repo_notes SET times_used = times_used + 1, last_used_at = now() WHERE note_id = $1",
			[n.note_id],
		);
	}
	return picked;
}

/** A fix built on this run's notes did not hold: lower their trust. */
export async function penalizeRunNotes(
	pool: Pool,
	runId: string,
	factor = 0.7,
): Promise<number> {
	const r = await pool.query(
		"UPDATE repo_notes SET confidence = confidence * $1 WHERE source_run_id = $2 AND kind IN ('root_cause','fix_recipe') AND source != 'human'",
		[factor, runId],
	);
	await pool.query(
		"UPDATE repo_notes SET status = 'retired' WHERE confidence < 0.2 AND source != 'human'",
	);
	return r.rowCount;
}

export async function listNotes(
	pool: Pool,
	repo: string,
	includeRetired = false,
): Promise<StoredNote[]> {
	const r = await pool.query<StoredNote>(
		`SELECT * FROM repo_notes WHERE repo = $1 ${includeRetired ? "" : "AND status = 'active'"} ORDER BY confidence DESC, created_at DESC`,
		[repo],
	);
	return r.rows;
}

export async function retireNote(pool: Pool, noteId: string): Promise<boolean> {
	const r = await pool.query(
		"UPDATE repo_notes SET status = 'retired' WHERE note_id = $1",
		[noteId],
	);
	return r.rowCount > 0;
}

export function formatNotesForPrompt(notes: StoredNote[]): string {
	if (notes.length === 0) return "(no notes yet for this repo)";
	return notes
		.map(
			(n) =>
				`- [${n.kind}, id ${n.note_id.slice(0, 8)}, confidence ${Number(n.confidence).toFixed(2)}] ${n.body}${n.files ? ` (files: ${n.files})` : ""}`,
		)
		.join("\n");
}
