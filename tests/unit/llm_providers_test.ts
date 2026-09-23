import { describe, expect, it } from "vitest";
import { createGeminiClient, toGeminiContents } from "../../src/llm/gemini.ts";
import { createGroqClient } from "../../src/llm/groq.ts";
import { createOllamaClient } from "../../src/llm/ollama.ts";
import { createOpenRouterClient } from "../../src/llm/openrouter.ts";
import type { ChatMessage, ToolSpec } from "../../src/llm/types.ts";

const tools: ToolSpec[] = [
	{
		name: "read_file",
		description: "read",
		parameters: {
			type: "object",
			properties: { path: { type: "string" } },
			required: ["path"],
		},
	},
];

function fakeFetch(
	reply: unknown,
	seen: { url?: string; body?: unknown; headers?: Record<string, string> },
): typeof fetch {
	return (async (url: string, init: RequestInit) => {
		seen.url = url;
		seen.body = JSON.parse(String(init.body));
		seen.headers = init.headers as Record<string, string>;
		return new Response(JSON.stringify(reply), { status: 200 });
	}) as unknown as typeof fetch;
}

const history: ChatMessage[] = [
	{ role: "user", content: "fix it" },
	{
		role: "assistant",
		content: "reading",
		toolCalls: [{ id: "c1", name: "read_file", args: { path: "a.ts" } }],
	},
	{ role: "tool", toolCallId: "c1", name: "read_file", content: "1\tconst x" },
];

describe("gemini", () => {
	it("maps tools/messages and parses functionCall parts", async () => {
		const seen: Record<string, unknown> = {};
		const c = createGeminiClient({
			apiKey: "KEY",
			model: "gemini-x",
			fetchImpl: fakeFetch(
				{
					candidates: [
						{
							content: {
								role: "model",
								parts: [
									{ text: "look", thought: false },
									{
										functionCall: { name: "read_file", args: { path: "b.ts" } },
										thoughtSignature: "sig",
									},
								],
							},
						},
					],
					usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
				},
				seen,
			),
		});
		const r = await c.chat({ system: "sys", messages: history, tools });
		expect(seen.url).toContain("/models/gemini-x:generateContent");
		expect((seen.headers as Record<string, string>)["x-goog-api-key"]).toBe(
			"KEY",
		);
		const body = seen.body as {
			tools: Array<{ functionDeclarations: unknown[] }>;
			contents: unknown[];
		};
		expect(body.tools[0]?.functionDeclarations).toHaveLength(1);
		expect(body.contents).toHaveLength(3);
		expect(r.text).toBe("look");
		expect(r.toolCalls[0]).toMatchObject({
			name: "read_file",
			args: { path: "b.ts" },
		});
		// raw content (with thought signatures) must be replayable verbatim
		expect(JSON.stringify(r.raw)).toContain("sig");
	});

	it("merges parallel tool results into one user turn", () => {
		const msgs: ChatMessage[] = [
			{ role: "user", content: "x" },
			{
				role: "assistant",
				content: "",
				toolCalls: [
					{ id: "1", name: "a", args: {} },
					{ id: "2", name: "b", args: {} },
				],
			},
			{ role: "tool", toolCallId: "1", name: "a", content: "r1" },
			{ role: "tool", toolCallId: "2", name: "b", content: "r2" },
		];
		const c = toGeminiContents(msgs);
		expect(c).toHaveLength(3);
		expect(c[2]?.parts).toHaveLength(2);
	});

	it("does not leak the API key into errors", async () => {
		const c = createGeminiClient({
			apiKey: "SECRETKEY",
			model: "m",
			fetchImpl: (async () =>
				new Response("nope", { status: 400 })) as unknown as typeof fetch,
		});
		await expect(
			c.chat({ system: "s", messages: history, tools }),
		).rejects.toThrow(/HTTP 400/);
		await c
			.chat({ system: "s", messages: history, tools })
			.catch((e) => expect(String(e)).not.toContain("SECRETKEY"));
	});
});

describe("openrouter", () => {
	it("uses OpenAI-style tool calls and parses string arguments", async () => {
		const seen: Record<string, unknown> = {};
		const c = createOpenRouterClient({
			apiKey: "K",
			model: "vendor/model",
			fetchImpl: fakeFetch(
				{
					choices: [
						{
							message: {
								content: null,
								tool_calls: [
									{
										id: "t1",
										function: {
											name: "read_file",
											arguments: '{"path":"z.ts"}',
										},
									},
								],
							},
						},
					],
				},
				seen,
			),
		});
		const r = await c.chat({ system: "sys", messages: history, tools });
		expect(seen.url).toBe("https://openrouter.ai/api/v1/chat/completions");
		expect((seen.headers as Record<string, string>).authorization).toBe(
			"Bearer K",
		);
		const body = seen.body as {
			messages: Array<{
				role: string;
				tool_calls?: unknown[];
				tool_call_id?: string;
			}>;
		};
		expect(body.messages[0]?.role).toBe("system");
		expect(body.messages[2]?.tool_calls).toHaveLength(1);
		expect(body.messages[3]).toMatchObject({
			role: "tool",
			tool_call_id: "c1",
		});
		expect(r.toolCalls[0]).toMatchObject({
			id: "t1",
			name: "read_file",
			args: { path: "z.ts" },
		});
	});
});

describe("groq", () => {
	it("uses OpenAI-style tool calls on the groq endpoint", async () => {
		const seen: Record<string, unknown> = {};
		const c = createGroqClient({
			apiKey: "K",
			model: "openai/gpt-oss-120b",
			fetchImpl: fakeFetch(
				{
					choices: [
						{
							message: {
								content: null,
								tool_calls: [
									{
										id: "t1",
										function: {
											name: "read_file",
											arguments: '{"path":"z.ts"}',
										},
									},
								],
							},
						},
					],
				},
				seen,
			),
		});
		const r = await c.chat({ system: "sys", messages: history, tools });
		expect(seen.url).toBe("https://api.groq.com/openai/v1/chat/completions");
		expect((seen.headers as Record<string, string>).authorization).toBe(
			"Bearer K",
		);
		const body = seen.body as {
			model: string;
			max_tokens: number;
			messages: Array<{ role: string; tool_calls?: unknown[] }>;
		};
		expect(body.model).toBe("openai/gpt-oss-120b");
		expect(body.max_tokens).toBe(512); // free-tier OTPM-friendly output cap
		expect(body.messages[0]?.role).toBe("system");
		expect(body.messages[2]?.tool_calls).toHaveLength(1);
		expect(r.toolCalls[0]).toMatchObject({
			id: "t1",
			name: "read_file",
			args: { path: "z.ts" },
		});
	});

	it("hides the api key from error messages", async () => {
		const c = createGroqClient({
			apiKey: "SECRETKEY",
			model: "openai/gpt-oss-120b",
			fetchImpl: (async () =>
				new Response('{"error":{"message":"bad"}}', {
					status: 400,
				})) as unknown as typeof fetch,
		});
		await expect(
			c.chat({ system: "s", messages: history, tools }),
		).rejects.toThrow(/HTTP 400/);
		await c
			.chat({ system: "s", messages: history, tools })
			.catch((e) => expect(String(e)).not.toContain("SECRETKEY"));
	});
});

describe("ollama", () => {
	it("hits /api/chat with object arguments and no stream", async () => {
		const seen: Record<string, unknown> = {};
		const c = createOllamaClient({
			baseUrl: "http://127.0.0.1:11434/",
			model: "qwen3-coder",
			fetchImpl: fakeFetch(
				{
					message: {
						content: "hm",
						tool_calls: [
							{ function: { name: "read_file", arguments: { path: "q.py" } } },
						],
					},
					eval_count: 3,
				},
				seen,
			),
		});
		const r = await c.chat({ system: "sys", messages: history, tools });
		expect(seen.url).toBe("http://127.0.0.1:11434/api/chat");
		expect((seen.body as { stream: boolean }).stream).toBe(false);
		expect(r.toolCalls[0]).toMatchObject({
			name: "read_file",
			args: { path: "q.py" },
		});
	});

	it("gives a clear error when the model lacks tool support", async () => {
		const c = createOllamaClient({
			baseUrl: "http://x",
			model: "tiny",
			fetchImpl: (async () =>
				new Response(
					'{"error":"registry.ollama.ai/library/tiny does not support tools"}',
					{ status: 400 },
				)) as unknown as typeof fetch,
		});
		await expect(
			c.chat({ system: "s", messages: history, tools }),
		).rejects.toThrow(/does not support tool calling/);
	});
});
