import { beforeAll, describe, expect, it } from "vitest";
import {
	addNote,
	listNotes,
	penalizeRunNotes,
	retireNote,
	retrieveNotes,
	sanitizeNote,
} from "../../src/memory/notes.ts";
import { memPool } from "../helpers/mem.ts";

const pool = await memPool();
const REPO = "acme/shop";

describe("repo notes", () => {
	beforeAll(async () => {
		await addNote(
			pool,
			{ repo: REPO, source: "agent", runId: "run-1" },
			{
				kind: "flaky_hint",
				text: "Tests in payment.spec.ts are flaky because of a shared Stripe mock timeout.",
				tags: ["payment", "timeout"],
				files: ["tests/payment.spec.ts"],
			},
		);
		await addNote(
			pool,
			{ repo: REPO, source: "agent", runId: "run-1" },
			{
				kind: "root_cause",
				text: "TypeError on cart totals came from cents/dollars mixups in cart.ts.",
				tags: ["typeerror", "cart"],
				files: ["src/cart.ts"],
			},
		);
		await addNote(
			pool,
			{ repo: "other/repo", source: "agent" },
			{
				kind: "gotcha",
				text: "Other repo needs docker for tests, unrelated to shop.",
			},
		);
	});

	it("retrieves relevant notes for a failure log, scoped to the repo", async () => {
		const got = await retrieveNotes(
			pool,
			REPO,
			"FAIL tests/payment.spec.ts  Timeout - Async callback was not invoked",
		);
		expect(got[0]?.body).toContain("payment.spec.ts");
		expect(got.every((n) => n.repo === REPO)).toBe(true);
		expect(got.find((n) => n.body.includes("cents/dollars"))).toBeUndefined();
	});

	it("marks retrieved notes as used", async () => {
		const notes = await listNotes(pool, REPO);
		expect(
			notes.find((n) => n.kind === "flaky_hint")?.times_used,
		).toBeGreaterThan(0);
	});

	it("merges near-duplicate notes instead of piling them up", async () => {
		const before = (await listNotes(pool, REPO)).length;
		const r = await addNote(
			pool,
			{ repo: REPO, source: "agent" },
			{
				kind: "flaky_hint",
				text: "payment.spec.ts tests are flaky due to shared Stripe mock timeout",
				tags: ["payment"],
			},
		);
		expect(r?.merged).toBe(true);
		expect((await listNotes(pool, REPO)).length).toBe(before);
	});

	it("decays trust in notes behind a fix that did not hold, and can retire notes", async () => {
		await penalizeRunNotes(pool, "run-1");
		const rc = (await listNotes(pool, REPO)).find(
			(n) => n.kind === "root_cause",
		);
		expect(Number(rc?.confidence)).toBeLessThan(0.6);
		expect(await retireNote(pool, rc?.note_id ?? "")).toBe(true);
		expect(
			(await listNotes(pool, REPO)).find((n) => n.kind === "root_cause"),
		).toBeUndefined();
	});

	it("sanitizes: redacts secrets, drops junk, caps length", () => {
		expect(sanitizeNote({ kind: "gotcha", text: "x" })).toBeNull();
		const n = sanitizeNote({
			kind: "bogus",
			text: `use token ghp_${"a".repeat(36)} for it ${"y".repeat(500)}`,
			files: ["../../etc/passwd", "src/ok.ts"],
		});
		expect(n?.kind).toBe("gotcha");
		expect(n?.body).not.toContain("ghp_");
		expect(n?.body.length).toBeLessThanOrEqual(300);
		expect(n?.files).toEqual(["src/ok.ts"]);
	});
});
