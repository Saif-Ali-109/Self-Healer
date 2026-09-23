// Provider-neutral chat + tool-calling types. Supported providers:
// Gemini, OpenRouter, Ollama, Groq (OpenAI-compatible endpoint).

export const PROVIDERS = ["gemini", "openrouter", "ollama", "groq"] as const;
export type ProviderName = (typeof PROVIDERS)[number];

export function isProviderName(v: unknown): v is ProviderName {
	return typeof v === "string" && (PROVIDERS as readonly string[]).includes(v);
}

export interface JsonSchema {
	type: "object" | "string" | "number" | "integer" | "boolean" | "array";
	description?: string;
	properties?: Record<string, JsonSchema>;
	items?: JsonSchema;
	required?: string[];
	enum?: string[];
}

export interface ToolSpec {
	name: string;
	description: string;
	parameters: JsonSchema; // top-level is always type:"object"
}

export interface ToolCall {
	id: string;
	name: string;
	args: Record<string, unknown>;
}

export type ChatMessage =
	| { role: "user"; content: string }
	| {
			role: "assistant";
			content: string;
			toolCalls?: ToolCall[];
			/** Provider-native content to replay verbatim (e.g. Gemini thought signatures). */
			raw?: unknown;
	  }
	| { role: "tool"; toolCallId: string; name: string; content: string };

export interface ChatRequest {
	system: string;
	messages: ChatMessage[];
	tools: ToolSpec[];
	temperature?: number;
	maxOutputTokens?: number;
	signal?: AbortSignal;
}

export interface ChatResponse {
	text: string;
	toolCalls: ToolCall[];
	raw?: unknown;
	usage?: { inputTokens?: number; outputTokens?: number };
	finishReason?: string;
}

export interface LlmClient {
	readonly provider: ProviderName;
	readonly model: string;
	chat(req: ChatRequest): Promise<ChatResponse>;
}

export class LlmError extends Error {
	readonly retryable: boolean;
	readonly status: number | undefined;
	constructor(
		message: string,
		opts: { retryable?: boolean; status?: number } = {},
	) {
		super(message);
		this.name = "LlmError";
		this.retryable = opts.retryable ?? false;
		this.status = opts.status;
	}
}
