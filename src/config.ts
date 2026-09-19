// Environment / secret loader — validates at startup, never logs values.

import { existsSync, readFileSync } from "node:fs";

const REQUIRED_ENV = ["GH_TOKEN", "CI_WEBHOOK_SECRET", "DATABASE_URL"] as const;

/** Load `file` (default .env) into process.env if present. Variables already
 *  set in the real process environment are never overridden; within the file,
 *  later keys win (so `GH_TOKEN=` placeholder lines followed by a real value
 *  resolve correctly). Idempotent. */
export function loadEnvFile(file = ".env"): void {
	try {
		if (!existsSync(file)) return;
		const preexisting = new Set(Object.keys(process.env));
		for (const line of readFileSync(file, "utf8").split("\n")) {
			const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
			if (!m) continue;
			const key = m[1];
			let value = m[2] ?? "";
			if (value.startsWith('"') && value.endsWith('"')) {
				value = value.slice(1, -1);
			}
			if (key && !preexisting.has(key)) process.env[key] = value;
		}
	} catch {
		// ignore unreadable .env
	}
}

export interface AppConfig {
	ghToken: string;
	webhookSecret: string;
	databaseUrl: string;
	webhookPort: number;
	sorSigningKey: string | undefined;
	sorKeyId: string;
	llm: {
		geminiApiKey: string | undefined;
		openrouterApiKey: string | undefined;
		ollamaBaseUrl: string;
	};
}

/**
 * Load and validate configuration from environment variables.
 * Fails loudly with a clear message listing missing required vars.
 * Secrets are never logged or included in error messages beyond their key name.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
	// Load .env first so a bare `node src/...` (or the global CLI) works
	// without the --env-file-if-exists npm flag.
	loadEnvFile();
	const required = (key: string): string => env[key] ?? "";
	const missing = REQUIRED_ENV.filter((k) => {
		const v = env[k];
		return v === undefined || v.trim() === "";
	});
	if (missing.length > 0) {
		throw new Error(
			`Missing required environment variables: ${missing.join(", ")}. See .env.example.`,
		);
	}

	return {
		ghToken: required("GH_TOKEN"),
		webhookSecret: required("CI_WEBHOOK_SECRET"),
		databaseUrl: required("DATABASE_URL"),
		webhookPort: Number(env.CI_WEBHOOK_PORT) || 3457,
		sorSigningKey: env.SOR_SIGNING_KEY || undefined,
		sorKeyId: env.SOR_KEY_ID || "v1",
		llm: {
			geminiApiKey: env.GEMINI_API_KEY || undefined,
			openrouterApiKey: env.OPENROUTER_API_KEY || undefined,
			ollamaBaseUrl: env.OLLAMA_BASE_URL || "http://127.0.0.1:11434",
		},
	};
}
