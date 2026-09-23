// Provider selection: per-repo override > global default (settings file) >
// env defaults > first provider that has credentials. Built once per run.

import { DEFAULT_MODELS, type Settings, repoSettings } from "../settings.ts";
import { createGeminiClient } from "./gemini.ts";
import { createGroqClient } from "./groq.ts";
import { createOllamaClient } from "./ollama.ts";
import { createOpenRouterClient } from "./openrouter.ts";
import { isProviderName, type LlmClient, type ProviderName } from "./types.ts";

export interface LlmCredentials {
	geminiApiKey?: string | undefined;
	openrouterApiKey?: string | undefined;
	groqApiKey?: string | undefined;
	ollamaBaseUrl: string;
}

export interface ResolvedLlm {
	provider: ProviderName;
	model: string;
	temperature?: number;
	/** Where the choice came from — surfaced in the audit trail. */
	origin: "repo" | "global" | "env" | "auto";
}

export function credentialsFromEnv(
	env: NodeJS.ProcessEnv = process.env,
): LlmCredentials {
	return {
		geminiApiKey: env.GEMINI_API_KEY || undefined,
		openrouterApiKey: env.OPENROUTER_API_KEY || undefined,
		groqApiKey: env.GROQ_API_KEY || undefined,
		ollamaBaseUrl: env.OLLAMA_BASE_URL || "http://127.0.0.1:11434",
	};
}

function hasCredentials(
	p: ProviderName,
	c: LlmCredentials,
	ollamaExplicit: boolean,
): boolean {
	if (p === "gemini") return !!c.geminiApiKey;
	if (p === "openrouter") return !!c.openrouterApiKey;
	if (p === "groq") return !!c.groqApiKey;
	return ollamaExplicit; // Ollama has no key; only "auto" if the operator set a URL.
}

export function resolveLlm(
	settings: Settings,
	repo: string,
	creds: LlmCredentials,
	env: NodeJS.ProcessEnv = process.env,
): ResolvedLlm {
	const repoLlm = repoSettings(settings, repo).llm ?? {};
	const globalLlm = settings.llm;
	const envProvider = isProviderName(env.SELF_HEALER_LLM_PROVIDER)
		? env.SELF_HEALER_LLM_PROVIDER
		: undefined;

	let provider: ProviderName | undefined;
	let origin: ResolvedLlm["origin"] = "auto";
	if (repoLlm.provider) {
		provider = repoLlm.provider;
		origin = "repo";
	} else if (globalLlm.provider) {
		provider = globalLlm.provider;
		origin = "global";
	} else if (envProvider) {
		provider = envProvider;
		origin = "env";
	} else {
		const ollamaExplicit = !!env.OLLAMA_BASE_URL;
		provider = (["gemini", "groq", "openrouter", "ollama"] as const).find(
			(p) => hasCredentials(p, creds, ollamaExplicit),
		);
	}
	if (!provider) {
		throw new Error(
			"no LLM provider configured: set llm.provider in self-healer.config.json, or GEMINI_API_KEY / OPENROUTER_API_KEY / GROQ_API_KEY / OLLAMA_BASE_URL",
		);
	}

	const model =
		repoLlm.model ??
		(globalLlm.provider === provider ? globalLlm.model : undefined) ??
		(origin === "env" || origin === "auto"
			? env.SELF_HEALER_LLM_MODEL
			: undefined) ??
		DEFAULT_MODELS[provider];
	if (!model) {
		throw new Error(
			`no model configured for provider "${provider}": set llm.model (or repos.<repo>.llm.model) in self-healer.config.json`,
		);
	}
	const temperature = repoLlm.temperature ?? globalLlm.temperature;
	return {
		provider,
		model,
		...(temperature !== undefined ? { temperature } : {}),
		origin,
	};
}

export function createLlmClient(
	choice: ResolvedLlm,
	creds: LlmCredentials,
	fetchImpl?: typeof fetch,
): LlmClient {
	const f = fetchImpl ? { fetchImpl } : {};
	switch (choice.provider) {
		case "gemini":
			if (!creds.geminiApiKey) throw new Error("GEMINI_API_KEY is not set");
			return createGeminiClient({
				apiKey: creds.geminiApiKey,
				model: choice.model,
				...f,
			});
		case "openrouter":
			if (!creds.openrouterApiKey)
				throw new Error("OPENROUTER_API_KEY is not set");
			return createOpenRouterClient({
				apiKey: creds.openrouterApiKey,
				model: choice.model,
				...f,
			});
		case "groq":
			if (!creds.groqApiKey) throw new Error("GROQ_API_KEY is not set");
			return createGroqClient({
				apiKey: creds.groqApiKey,
				model: choice.model,
				...f,
			});
		case "ollama":
			return createOllamaClient({
				baseUrl: creds.ollamaBaseUrl,
				model: choice.model,
				...f,
			});
	}
}
