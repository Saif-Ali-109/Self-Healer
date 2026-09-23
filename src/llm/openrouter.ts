// OpenRouter (OpenAI-compatible chat completions) client with tool calling.
import { postJson } from "./http.ts";
import {
	type ChatMessage,
	type ChatRequest,
	type ChatResponse,
	type LlmClient,
	LlmError,
	type ToolCall,
} from "./types.ts";

export function toOpenAiMessages(
	system: string,
	messages: ChatMessage[],
): unknown[] {
	const out: unknown[] = [{ role: "system", content: system }];
	for (const m of messages) {
		if (m.role === "user") out.push({ role: "user", content: m.content });
		else if (m.role === "assistant") {
			const msg: Record<string, unknown> = {
				role: "assistant",
				content: m.content || null,
			};
			if (m.toolCalls && m.toolCalls.length > 0) {
				msg.tool_calls = m.toolCalls.map((c) => ({
					id: c.id,
					type: "function",
					function: { name: c.name, arguments: JSON.stringify(c.args) },
				}));
			}
			out.push(msg);
		} else {
			out.push({
				role: "tool",
				tool_call_id: m.toolCallId,
				content: m.content,
			});
		}
	}
	return out;
}

export function createOpenRouterClient(opts: {
	apiKey: string;
	model: string;
	baseUrl?: string;
	fetchImpl?: typeof fetch;
}): LlmClient {
	const base = opts.baseUrl ?? "https://openrouter.ai/api/v1";
	return {
		provider: "openrouter",
		model: opts.model,
		async chat(req: ChatRequest): Promise<ChatResponse> {
			const body: Record<string, unknown> = {
				model: opts.model,
				messages: toOpenAiMessages(req.system, req.messages),
				temperature: req.temperature ?? 0.2,
				max_tokens: req.maxOutputTokens ?? 8192,
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
				headers: {
					authorization: `Bearer ${opts.apiKey}`,
					"x-title": "Self-Healer CI Agent",
				},
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
					`openrouter returned no message${data.error?.message ? `: ${data.error.message}` : ""}`,
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
