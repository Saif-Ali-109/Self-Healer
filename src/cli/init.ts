// `self-healer init` — create .env (with generated secrets) + SQLite database.

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { loadEnvFile } from "../config.ts";
import { migrateUp } from "../db/migrate.ts";
import { resolveDbPath } from "../db/sqlite.ts";
import { packagePath } from "../paths.ts";

const ENV_TEMPLATE = packagePath(".env.example");

/** 64-hex random secret (32 bytes). Exported for tests. */
export function generateSecret(): string {
	return randomBytes(32).toString("hex");
}

/** Fill an .env template with the generated secret + a local DB path. Pure. */
export function renderEnvFile(template: string, secret: string): string {
	return template
		.replace(/^CI_WEBHOOK_SECRET=.*$/m, `CI_WEBHOOK_SECRET=${secret}`)
		.replace(/^SOR_SIGNING_KEY=.*$/m, `SOR_SIGNING_KEY=${secret}`)
		.replace(/^DATABASE_URL=.*$/m, "DATABASE_URL=./data/self-healer.db");
}

function writeEnv(): void {
	const template = existsSync(ENV_TEMPLATE)
		? readFileSync(ENV_TEMPLATE, "utf8")
		: "GH_TOKEN=\nCI_WEBHOOK_SECRET=\nDATABASE_URL=./data/self-healer.db\nSOR_SIGNING_KEY=\nSOR_KEY_ID=v1\n";
	const secret = generateSecret();
	writeFileSync(".env", renderEnvFile(template, secret), { mode: 0o600 });
}

/** Initialize: create .env (if missing) and provision the SQLite schema. */
export async function cliInit(force = false): Promise<void> {
	loadEnvFile(); // pick up any pre-existing .env from the environment

	if (!existsSync(".env")) {
		writeEnv();
		console.log(
			"✔ .env created (CI_WEBHOOK_SECRET + SOR_SIGNING_KEY generated)",
		);
	} else if (force) {
		renameSync(".env", ".env.bak");
		writeEnv();
		console.log("✔ .env regenerated (previous file saved as .env.bak)");
	} else {
		console.log(
			"· .env already exists — keeping it (use --force to regenerate)",
		);
	}

	loadEnvFile(); // load the (possibly new) .env
	const applied = migrateUp();
	console.log(
		`✔ SQLite database ready at ${resolveDbPath()} (${applied} migration(s) applied)`,
	);
	console.log("");
	console.log("Next steps:");
	console.log(
		"  1. Set GH_TOKEN in .env (scopes: repo, actions:write, read:org)",
	);
	console.log(
		"  2. Add SELF_HEALER_URL + CI_WEBHOOK_SECRET repo secrets to each repo you watch",
	);
	console.log("  3. self-healer enable --repo owner/repo");
	console.log("  4. self-healer start");
}
