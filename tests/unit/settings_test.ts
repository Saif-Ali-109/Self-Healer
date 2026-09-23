import { describe, expect, it } from "vitest";
import { createLlmClient, resolveLlm } from "../../src/llm/resolve.ts";
import { limitsFor, parseSettings, repoSettings } from "../../src/settings.ts";

const noCreds = { ollamaBaseUrl: "http://127.0.0.1:11434" };

describe("parseSettings", () => {
	it("accepts an empty config and applies defaults (fix cycles = 3)", () => {
		const s = parseSettings({});
		expect(s.agent.maxFixCycles).toBe(3);
		expect(s.llm).toEqual({});
	});

	it("rejects providers outside gemini/groq/openrouter/ollama", () => {
		expect(() =>
			parseSettings({ llm: { provider: "openai", model: "x" } }),
		).toThrow(/provider must be one of gemini, openrouter, ollama, groq/);
		expect(() => parseSettings({ llm: { provider: "claude" } })).toThrow(
			/provider/,
		);
	});

	it("rejects malformed repo keys and limits", () => {
		expect(() => parseSettings({ repos: { "not a repo": {} } })).toThrow(
			/repos key/,
		);
		expect(() => parseSettings({ agent: { maxFixCycles: -1 } })).toThrow(
			/maxFixCycles/,
		);
		expect(() => parseSettings({ agent: { maxLlmCalls: 0 } })).toThrow(
			/maxLlmCalls/,
		);
	});
});

describe("repo settings precedence", () => {
	const s = parseSettings({
		llm: { provider: "gemini", model: "g-1" },
		agent: { maxFixCycles: 3 },
		repos: {
			"*": { verifyCommands: ["npm run lint"] },
			"acme/*": { llm: { provider: "openrouter", model: "or-1" } },
			"acme/api": {
				llm: { model: "or-2" },
				maxFixCycles: 1,
				testCommand: "pnpm test",
			},
		},
	});

	it("exact repo beats owner glob beats star, merged field by field", () => {
		const r = repoSettings(s, "acme/api");
		expect(r.llm).toEqual({ provider: "openrouter", model: "or-2" });
		expect(r.testCommand).toBe("pnpm test");
		expect(r.verifyCommands).toEqual(["npm run lint"]);
		expect(repoSettings(s, "acme/web").llm?.model).toBe("or-1");
		expect(repoSettings(s, "other/x").llm).toEqual({});
	});

	it("per-repo fix-cycle cap overrides the global one", () => {
		expect(limitsFor(s, "acme/api").maxFixCycles).toBe(1);
		expect(limitsFor(s, "acme/web").maxFixCycles).toBe(3);
	});
});

describe("resolveLlm", () => {
	const s = parseSettings({
		llm: { provider: "gemini", model: "g-1" },
		repos: {
			"acme/local": { llm: { provider: "ollama", model: "qwen3-coder:30b" } },
		},
	});

	it("uses the global default when a repo has no override", () => {
		const r = resolveLlm(s, "acme/web", { geminiApiKey: "k", ...noCreds }, {});
		expect(r).toMatchObject({
			provider: "gemini",
			model: "g-1",
			origin: "global",
		});
	});

	it("uses the per-repo override for that repo only", () => {
		const r = resolveLlm(
			s,
			"acme/local",
			{ geminiApiKey: "k", ...noCreds },
			{},
		);
		expect(r).toMatchObject({
			provider: "ollama",
			model: "qwen3-coder:30b",
			origin: "repo",
		});
	});

	it("falls back to env, then to the first provider with credentials", () => {
		const empty = parseSettings({});
		expect(
			resolveLlm(empty, "a/b", noCreds, {
				SELF_HEALER_LLM_PROVIDER: "ollama",
				SELF_HEALER_LLM_MODEL: "m",
			}),
		).toMatchObject({ provider: "ollama", model: "m", origin: "env" });
		expect(
			resolveLlm(
				empty,
				"a/b",
				{ openrouterApiKey: "k", ...noCreds },
				{ SELF_HEALER_LLM_MODEL: "x/y" },
			),
		).toMatchObject({ provider: "openrouter", model: "x/y", origin: "auto" });
	});

	it("errors clearly when nothing is configured or a model is missing", () => {
		expect(() => resolveLlm(parseSettings({}), "a/b", noCreds, {})).toThrow(
			/no LLM provider configured/,
		);
		expect(() =>
			resolveLlm(
				parseSettings({ llm: { provider: "openrouter" } }),
				"a/b",
				{ openrouterApiKey: "k", ...noCreds },
				{},
			),
		).toThrow(/no model configured/);
	});

	it("refuses to build a client without credentials", () => {
		expect(() =>
			createLlmClient(
				{ provider: "gemini", model: "m", origin: "global" },
				noCreds,
			),
		).toThrow(/GEMINI_API_KEY/);
	});
});
