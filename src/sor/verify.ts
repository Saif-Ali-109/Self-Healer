// SOR verification — replay the hash chain and report. Exported for tests;
// the CLI entry that calls it is verifyCli.ts (npm run sor:verify).

import type { Pool } from "../db/pool.ts";
import { verifyChain } from "./chain.ts";

/** Verify the chain, print a readable report, and return the exit code (0 ok, 1 fail). */
export async function runSorVerify(pool: Pool): Promise<number> {
	const result = await verifyChain(pool);

	const typeNames = Object.keys(result.counts).sort();
	console.log("chain verification report");
	console.log("-------------------------");
	if (typeNames.length === 0) {
		console.log("(no audit events)");
	} else {
		for (const typeName of typeNames) {
			console.log(`${typeName}: ${result.counts[typeName]}`);
		}
	}
	console.log("total:", result.total);
	console.log("ok:", result.ok ? "yes" : "no");
	if (!result.ok) {
		console.log("first bad seq:", result.firstBadSeq);
	}

	return result.ok ? 0 : 1;
}