// Environment / secret loader — validates at startup, never logs values.

const REQUIRED_ENV = ["GH_TOKEN", "CI_WEBHOOK_SECRET", "DATABASE_URL"] as const;

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
export function loadConfig(
	env: NodeJS.ProcessEnv = process.env,
): AppConfig {
	const missing = REQUIRED_ENV.filter((k) => !env[k] || env[k]!.trim() === "");
	if (missing.length > 0) {
		throw new Error(
			`Missing required environment variables: ${missing.join(", ")}. See .env.example.`,
		);
	}

	return {
		ghToken: env.GH_TOKEN!,
		webhookSecret: env.CI_WEBHOOK_SECRET!,
		databaseUrl: env.DATABASE_URL!,
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
