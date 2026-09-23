import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
for (const line of readFileSync(".env", "utf8").split("\n")) {
	const [k, v] = line.split("=", 2);
	if (k && v && !process.env[k]) process.env[k] = v;
}
const { computeHash, canonicalJson, GENESIS_HASH } = await import(
	"./src/sor/signer.ts"
);
const { eventToRecord } = await import("./src/sor/events.ts");

const db = new DatabaseSync("./data/self-healer.db");
const rows = db.prepare("SELECT * FROM audit_events ORDER BY seq").all() as Array<
	Record<string, unknown>
>;

const REAL_KEY = process.env.SOR_SIGNING_KEY!;
const TEST_KEY = "test-signing-key-for-agent-tests-0123456789";

const rec = (r: Record<string, unknown>) =>
	eventToRecord({
		run_id: r.run_id as string,
		event_type: r.event_type as string,
		actor: r.actor as string,
		backend: r.backend as string | null,
		tool_name: r.tool_name as string | null,
		tool_input: r.tool_input ? JSON.parse(r.tool_input as string) : null,
		tool_output: r.tool_output ? JSON.parse(r.tool_output as string) : null,
		payload: JSON.parse(r.payload as string) as Record<string, unknown>,
		created_at: new Date(r.created_at as number).toISOString(),
	});

function replay(key: string): { firstBad: number | null; badCount: number } {
	let prev = GENESIS_HASH;
	let firstBad: number | null = null;
	let badCount = 0;
	for (const r of rows) {
		const h = computeHash(key, prev, canonicalJson({ ...rec(r), key_id: r.key_id }));
		if (h !== r.hash) {
			badCount++;
			if (firstBad === null) firstBad = r.seq as number;
		}
		prev = r.hash as string;
	}
	return { firstBad, badCount };
}

console.log("replay with REAL key :", replay(REAL_KEY));
console.log("replay with TEST key :", replay(TEST_KEY));