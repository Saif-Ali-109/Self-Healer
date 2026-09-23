// Gemini (Google AI Studio REST) client with native function calling.
import { postJson } from "./http.ts";
import {
	type ChatMessage,
	type ChatRequest,
	type ChatResponse,
	type LlmClient,
	LlmError,
	type ToolCall,
} from "./types.ts";

interface GeminiPart {
	text?: string;
	thought?: boolean;
	functionCall?: { name: string; args?: Record<string, unknown>; id?: string };
	functionResponse?: { name: string; response: unknown };
	[k: string]: unknown;
}
interface GeminiContent {
	role: "user" | "model";
	parts: GeminiPart[];
}

export function toGeminiContents(messages: ChatMessage[]): GeminiContent[] {
	const out: GeminiContent[] = [];
	for (const m of messages) {
		if (m.role === "user") {
			out.push({ role: "user", parts: [{ text: m.content }] });
		} else if (m.role === "assistant") {
			if (m.raw && typeof m.raw === "object") {
				// Replay verbatim so thought signatures survive multi-turn tool use.
				out.push(m.raw as GeminiContent);
				continue;
			}
			const parts: GeminiPart[] = [];
			if (m.content) parts.push({ text: m.content });
			for (const c of m.toolCalls ?? []) {
				parts.push({ functionCall: { name: c.name, args: c.args } });
			}
			if (parts.length === 0) parts.push({ text: "" });
			out.push({ role: "model", parts });
		} else {
			const part: GeminiPart = {
				functionResponse: { name: m.name, response: { result: m.content } },
			};
			const last = out[out.length - 1];
			// Parallel tool results must share ONE user turn.
			if (
				last &&
				last.role === "user" &&
				last.parts.every((p) => p.functionResponse)
			) {
				last.parts.push(part);
			} else {
				out.push({ role: "user", parts: [part] });
			}
		}
	}
	return out;
}

export function createGeminiClient(opts: {
	apiKey: string;
	model: string;
	baseUrl?: string;
	fetchImpl?: typeof fetch;
}): LlmClient {
	const base = opts.baseUrl ?? "https://generativelanguage.googleapis.com";
	return {
		provider: "gemini",
		model: opts.model,
		async chat(req: ChatRequest): Promise<ChatResponse> {
			const body: Record<string, unknown> = {
				systemInstruction: { parts: [{ text: req.system }] },
				contents: toGeminiContents(req.messages),
				generationConfig: {
					temperature: req.temperature ?? 0.2,
					maxOutputTokens: req.maxOutputTokens ?? 8192,
				},
			};
			if (req.tools.length > 0) {
				body.tools = [
					{
						functionDeclarations: req.tools.map((t) => ({
							name: t.name,
							description: t.description,
							parameters: t.parameters,
						})),
					},
				];
				body.toolConfig = { functionCallingConfig: { mode: "AUTO" } };
			}
			const data = (await postJson({
				url: `${base}/v1beta/models/${encodeURIComponent(opts.model)}:generateContent`,
				headers: { "x-goog-api-key": opts.apiKey },
				body,
				signal: req.signal,
				fetchImpl: opts.fetchImpl,
			})) as {
				candidates?: Array<{ content?: GeminiContent; finishReason?: string }>;
				promptFeedback?: { blockReason?: string };
				usageMetadata?: {
					promptTokenCount?: number;
					candidatesTokenCount?: number;
				};
			};
			const cand = data.candidates?.[0];
			if (!cand?.content) {
				throw new LlmError(
					`gemini returned no content (${data.promptFeedback?.blockReason ?? cand?.finishReason ?? "empty"})`,
					{ retryable: false },
				);
			}
			const parts = cand.content.parts ?? [];
			const text = parts
				.filter((p) => typeof p.text === "string" && !p.thought)
				.map((p) => p.text as string)
				.join("");
			const toolCalls: ToolCall[] = [];
			for (const p of parts) {
				if (p.functionCall) {
					toolCalls.push({
						id: p.functionCall.id ?? `call_${toolCalls.length}_${Date.now()}`,
						name: p.functionCall.name,
						args: p.functionCall.args ?? {},
					});
				}
			}
			return {
				text,
				toolCalls,
				raw: { role: "model", parts },
				usage: {
					inputTokens: data.usageMetadata?.promptTokenCount,
					outputTokens: data.usageMetadata?.candidatesTokenCount,
				},
				finishReason: cand.finishReason,
			};
		},
	};
}
