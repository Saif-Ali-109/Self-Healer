// Ollama (local/self-hosted) client using /api/chat with native tool calling.
// The model MUST support tools (e.g. qwen3-coder, llama3.1+, mistral-nemo);
// a model without tool support fails with a clear error.
import { postJson } from "./http.ts";
import {
	type ChatMessage,
	type ChatRequest,
	type ChatResponse,
	type LlmClient,
	LlmError,
	type ToolCall,
} from "./types.ts";

export function toOllamaMessages(
	system: string,
	messages: ChatMessage[],
): unknown[] {
	const out: unknown[] = [{ role: "system", content: system }];
	for (const m of messages) {
		if (m.role === "user") out.push({ role: "user", content: m.content });
		else if (m.role === "assistant") {
			const msg: Record<string, unknown> = {
				role: "assistant",
				content: m.content,
			};
			if (m.toolCalls && m.toolCalls.length > 0) {
				msg.tool_calls = m.toolCalls.map((c) => ({
					function: { name: c.name, arguments: c.args },
				}));
			}
			out.push(msg);
		} else out.push({ role: "tool", tool_name: m.name, content: m.content });
	}
	return out;
}

export function createOllamaClient(opts: {
	baseUrl: string;
	model: string;
	numCtx?: number;
	fetchImpl?: typeof fetch;
}): LlmClient {
	const base = opts.baseUrl.replace(/\/+$/, "");
	return {
		provider: "ollama",
		model: opts.model,
		async chat(req: ChatRequest): Promise<ChatResponse> {
			const body: Record<string, unknown> = {
				model: opts.model,
				messages: toOllamaMessages(req.system, req.messages),
				stream: false,
				options: {
					temperature: req.temperature ?? 0.2,
					num_predict: req.maxOutputTokens ?? 8192,
					num_ctx: opts.numCtx ?? 32768,
				},
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
			}
			let data: {
				message?: {
					content?: string;
					tool_calls?: Array<{
						function?: {
							name?: string;
							arguments?: Record<string, unknown> | string;
						};
					}>;
				};
				prompt_eval_count?: number;
				eval_count?: number;
				done_reason?: string;
			};
			try {
				data = (await postJson({
					url: `${base}/api/chat`,
					headers: {},
					body,
					signal: req.signal,
					timeoutMs: 600_000, // local models can be slow
					fetchImpl: opts.fetchImpl,
				})) as typeof data;
			} catch (err) {
				if (
					err instanceof LlmError &&
					/does not support tools/i.test(err.message)
				) {
					throw new LlmError(
						`ollama model "${opts.model}" does not support tool calling; choose a tool-capable model`,
					);
				}
				throw err;
			}
			if (!data.message) throw new LlmError("ollama returned no message");
			const toolCalls: ToolCall[] = [];
			for (const c of data.message.tool_calls ?? []) {
				if (!c.function?.name) continue;
				let args: Record<string, unknown> = {};
				if (typeof c.function.arguments === "string") {
					try {
						args = JSON.parse(c.function.arguments) as Record<string, unknown>;
					} catch {
						args = { __parse_error: c.function.arguments };
					}
				} else if (c.function.arguments) args = c.function.arguments;
				toolCalls.push({
					id: `call_${toolCalls.length}_${Date.now()}`,
					name: c.function.name,
					args,
				});
			}
			return {
				text: data.message.content ?? "",
				toolCalls,
				usage: {
					inputTokens: data.prompt_eval_count,
					outputTokens: data.eval_count,
				},
				finishReason: data.done_reason,
			};
		},
	};
}
