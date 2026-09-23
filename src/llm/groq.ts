// Groq (OpenAI-compatible chat completions at api.groq.com) client with tool
// calling. Groq exposes the same wire format as OpenRouter, so the request
// shaping is shared via `toOpenAiMessages`; only the endpoint + headers differ.
import { postJson } from "./http.ts";
import { toOpenAiMessages } from "./openrouter.ts";
import {
	type ChatRequest,
	type ChatResponse,
	type LlmClient,
	LlmError,
	type ToolCall,
} from "./types.ts";

export function createGroqClient(opts: {
	apiKey: string;
	model: string;
	baseUrl?: string;
	fetchImpl?: typeof fetch;
}): LlmClient {
	const base = opts.baseUrl ?? "https://api.groq.com/openai/v1";
	return {
		provider: "groq",
		model: opts.model,
		async chat(req: ChatRequest): Promise<ChatResponse> {
			const body: Record<string, unknown> = {
				model: opts.model,
				messages: toOpenAiMessages(req.system, req.messages),
				temperature: req.temperature ?? 0.2,
				// Groq's free tier enforces a small OTPM/TPM budget per minute
				// (e.g. 1000 output tokens/min on qwen3.8-27b); a huge
				// max_tokens reserve counts as "expected output" and is
				// rejected with 429/413. Cap it so agent turns fit.
				max_tokens: req.maxOutputTokens ?? 512,
			};
			if (req.tools.length > 0) {
				body.tools = req.tools.map((t) => ({
					type: "function",
					function: {
						name: t.name,
						description: t.description,
						parameters: t.parameters,
					},
				}));
				body.tool_choice = "auto";
			}
			const data = (await postJson({
				url: `${base}/chat/completions`,
				headers: { authorization: `Bearer ${opts.apiKey}` },
				body,
				signal: req.signal,
				fetchImpl: opts.fetchImpl,
			})) as {
				error?: { message?: string };
				choices?: Array<{
					finish_reason?: string;
					message?: {
						content?: string | null;
						tool_calls?: Array<{
							id?: string;
							function?: { name?: string; arguments?: string };
						}>;
					};
				}>;
				usage?: { prompt_tokens?: number; completion_tokens?: number };
			};
			const choice = data.choices?.[0];
			if (!choice?.message) {
				throw new LlmError(
					`groq returned no message${data.error?.message ? `: ${data.error.message}` : ""}`,
				);
			}
			const toolCalls: ToolCall[] = [];
			for (const c of choice.message.tool_calls ?? []) {
				if (!c.function?.name) continue;
				let args: Record<string, unknown> = {};
				try {
					args = JSON.parse(c.function.arguments || "{}") as Record<
						string,
						unknown
					>;
				} catch {
					args = { __parse_error: c.function.arguments ?? "" };
				}
				toolCalls.push({
					id: c.id ?? `call_${toolCalls.length}_${Date.now()}`,
					name: c.function.name,
					args,
				});
			}
			return {
				text: choice.message.content ?? "",
				toolCalls,
				usage: {
					inputTokens: data.usage?.prompt_tokens,
					outputTokens: data.usage?.completion_tokens,
				},
				finishReason: choice.finish_reason,
			};
		},
	};
}