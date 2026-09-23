// Operator settings file (JSON) — provider selection at global and per-repo
// level, plus agent limits and per-repo test commands. Secrets never live
// here; API keys stay in environment variables.
//
// Lookup: $SELF_HEALER_CONFIG, else ./self-healer.config.json. A missing file
// is fine (defaults + env are used). The file is re-read when its mtime
// changes, so operators can edit it without restarting the daemon.

import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { isProviderName, PROVIDERS, type ProviderName } from "./llm/types.ts";

export interface LlmChoice {
	provider: ProviderName;
	model: string;
	temperature?: number;
}

export interface AgentLimits {
	/** Re-fix cycles allowed after the first fix on one ci-fix branch. */
	maxFixCycles: number;
	/** Model calls per pipeline run (per failure). */
	maxLlmCalls: number;
	/** Tool executions per pipeline run. */
	maxToolCalls: number;
	/** Wall-clock budget per pipeline run. */
	pipelineBudgetMs: number;
	/** A fix touching this many files or more is refused (multi_file). */
	maxFilesChanged: number;
	/** Timeout for one run_command call. */
	commandTimeoutMs: number;
	/** Timeout for install / the full-suite gate. */
	gateTimeoutMs: number;
	/** Soft cap on conversation size before old tool output is elided. */
	maxContextChars: number;
	/** Prefix for every repo command, e.g. ["bwrap", "--ro-bind", "/", "/", ...]. */
	commandWrapper: string[];
}

export interface RepoSettings {
	llm?: Partial<LlmChoice>;
	testCommand?: string;
	installCommand?: string;
	/** Extra checks the gate must pass in addition to the test command (lint, typecheck…). */
	verifyCommands?: string[];
	maxFixCycles?: number;
	maxFilesChanged?: number;
}

export interface Settings {
	llm: Partial<LlmChoice>;
	agent: AgentLimits;
	repos: Record<string, RepoSettings>;
	/** File the settings came from, or null when defaults are in use. */
	source: string | null;
}

export const DEFAULT_AGENT_LIMITS: AgentLimits = {
	maxFixCycles: 3,
	maxLlmCalls: 40,
	maxToolCalls: 80,
	pipelineBudgetMs: 20 * 60_000,
	maxFilesChanged: 5,
	commandTimeoutMs: 5 * 60_000,
	gateTimeoutMs: 10 * 60_000,
	maxContextChars: 300_000,
	commandWrapper: [],
};

/** Gemini, Groq and Ollama have built-in defaults; OpenRouter slugs are operator choices. */
export const DEFAULT_MODELS: Partial<Record<ProviderName, string>> = {
	gemini: "gemini-2.5-pro",
	groq: "openai/gpt-oss-120b",
};

const REPO_KEY_RE = /^([A-Za-z0-9_.-]+\/([A-Za-z0-9_.-]+|\*)|\*)$/;

function bad(msg: string): never {
	throw new Error(`invalid settings: ${msg}`);
}

function parseLlm(raw: unknown, where: string): Partial<LlmChoice> {
	if (raw === undefined) return {};
	if (typeof raw !== "object" || raw === null || Array.isArray(raw))
		bad(`${where} must be an object`);
	const o = raw as Record<string, unknown>;
	const out: Partial<LlmChoice> = {};
	if (o.provider !== undefined) {
		if (!isProviderName(o.provider))
			bad(
				`${where}.provider must be one of ${PROVIDERS.join(", ")} (got ${JSON.stringify(o.provider)})`,
			);
		out.provider = o.provider;
	}
	if (o.model !== undefined) {
		if (typeof o.model !== "string" || o.model.trim() === "")
			bad(`${where}.model must be a non-empty string`);
		out.model = o.model.trim();
	}
	if (o.temperature !== undefined) {
		if (
			typeof o.temperature !== "number" ||
			o.temperature < 0 ||
			o.temperature > 2
		)
			bad(`${where}.temperature must be a number in [0, 2]`);
		out.temperature = o.temperature;
	}
	return out;
}

function posInt(v: unknown, where: string, min = 1): number {
	if (typeof v !== "number" || !Number.isInteger(v) || v < min)
		bad(`${where} must be an integer >= ${min}`);
	return v;
}

export function parseSettings(
	raw: unknown,
	source: string | null = null,
): Settings {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw))
		bad("top level must be an object");
	const root = raw as Record<string, unknown>;
	const agent: AgentLimits = { ...DEFAULT_AGENT_LIMITS };
	if (root.agent !== undefined) {
		if (typeof root.agent !== "object" || root.agent === null)
			bad("agent must be an object");
		const a = root.agent as Record<string, unknown>;
		if (a.maxFixCycles !== undefined)
			agent.maxFixCycles = posInt(a.maxFixCycles, "agent.maxFixCycles", 0);
		if (a.maxLlmCalls !== undefined)
			agent.maxLlmCalls = posInt(a.maxLlmCalls, "agent.maxLlmCalls");
		if (a.maxToolCalls !== undefined)
			agent.maxToolCalls = posInt(a.maxToolCalls, "agent.maxToolCalls");
		if (a.pipelineBudgetMs !== undefined)
			agent.pipelineBudgetMs = posInt(
				a.pipelineBudgetMs,
				"agent.pipelineBudgetMs",
				10_000,
			);
		if (a.maxFilesChanged !== undefined)
			agent.maxFilesChanged = posInt(
				a.maxFilesChanged,
				"agent.maxFilesChanged",
			);
		if (a.commandTimeoutMs !== undefined)
			agent.commandTimeoutMs = posInt(
				a.commandTimeoutMs,
				"agent.commandTimeoutMs",
				1000,
			);
		if (a.gateTimeoutMs !== undefined)
			agent.gateTimeoutMs = posInt(
				a.gateTimeoutMs,
				"agent.gateTimeoutMs",
				1000,
			);
		if (a.maxContextChars !== undefined)
			agent.maxContextChars = posInt(
				a.maxContextChars,
				"agent.maxContextChars",
				4_000,
			);
		if (a.commandWrapper !== undefined) {
			if (
				!Array.isArray(a.commandWrapper) ||
				!a.commandWrapper.every((x) => typeof x === "string")
			)
				bad("agent.commandWrapper must be an array of strings");
			agent.commandWrapper = a.commandWrapper as string[];
		}
	}
	const repos: Record<string, RepoSettings> = {};
	if (root.repos !== undefined) {
		if (
			typeof root.repos !== "object" ||
			root.repos === null ||
			Array.isArray(root.repos)
		)
			bad("repos must be an object keyed by owner/name");
		for (const [key, val] of Object.entries(
			root.repos as Record<string, unknown>,
		)) {
			if (!REPO_KEY_RE.test(key))
				bad(
					`repos key ${JSON.stringify(key)} must be owner/name, owner/*, or *`,
				);
			if (typeof val !== "object" || val === null)
				bad(`repos.${key} must be an object`);
			const r = val as Record<string, unknown>;
			const rs: RepoSettings = {};
			if (r.llm !== undefined) rs.llm = parseLlm(r.llm, `repos.${key}.llm`);
			if (r.testCommand !== undefined) {
				if (typeof r.testCommand !== "string" || !r.testCommand.trim())
					bad(`repos.${key}.testCommand must be a non-empty string`);
				rs.testCommand = r.testCommand.trim();
			}
			if (r.installCommand !== undefined) {
				if (typeof r.installCommand !== "string")
					bad(`repos.${key}.installCommand must be a string`);
				rs.installCommand = r.installCommand.trim();
			}
			if (r.verifyCommands !== undefined) {
				if (
					!Array.isArray(r.verifyCommands) ||
					!r.verifyCommands.every((x) => typeof x === "string")
				)
					bad(`repos.${key}.verifyCommands must be an array of strings`);
				rs.verifyCommands = r.verifyCommands as string[];
			}
			if (r.maxFixCycles !== undefined)
				rs.maxFixCycles = posInt(
					r.maxFixCycles,
					`repos.${key}.maxFixCycles`,
					0,
				);
			if (r.maxFilesChanged !== undefined)
				rs.maxFilesChanged = posInt(
					r.maxFilesChanged,
					`repos.${key}.maxFilesChanged`,
				);
			repos[key] = rs;
		}
	}
	return { llm: parseLlm(root.llm, "llm"), agent, repos, source };
}

let cache: { path: string; mtimeMs: number; settings: Settings } | null = null;

export function settingsPath(env: NodeJS.ProcessEnv = process.env): string {
	return resolve(env.SELF_HEALER_CONFIG || "self-healer.config.json");
}

/** Load settings (cached by mtime). A missing file yields defaults. Bad files throw. */
export function loadSettings(env: NodeJS.ProcessEnv = process.env): Settings {
	const path = settingsPath(env);
	if (!existsSync(path)) {
		if (env.SELF_HEALER_CONFIG)
			throw new Error(`SELF_HEALER_CONFIG points at a missing file: ${path}`);
		return parseSettings({}, null);
	}
	const mtimeMs = statSync(path).mtimeMs;
	if (cache && cache.path === path && cache.mtimeMs === mtimeMs)
		return cache.settings;
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch (err) {
		throw new Error(
			`invalid settings: ${path} is not valid JSON (${String(err)})`,
		);
	}
	const settings = parseSettings(raw, path);
	cache = { path, mtimeMs, settings };
	return settings;
}

/** Repo overrides: exact `owner/name` > `owner/*` > `*`, merged field-by-field. */
export function repoSettings(settings: Settings, repo: string): RepoSettings {
	const owner = repo.split("/")[0] ?? "";
	const layers = [
		settings.repos["*"],
		settings.repos[`${owner}/*`],
		settings.repos[repo],
	];
	const merged: RepoSettings = {};
	for (const l of layers) {
		if (!l) continue;
		Object.assign(merged, l, { llm: { ...merged.llm, ...l.llm } });
	}
	return merged;
}

/** Effective limits for a repo (repo-level overrides beat global agent limits). */
export function limitsFor(settings: Settings, repo: string): AgentLimits {
	const r = repoSettings(settings, repo);
	return {
		...settings.agent,
		...(r.maxFixCycles !== undefined ? { maxFixCycles: r.maxFixCycles } : {}),
		...(r.maxFilesChanged !== undefined
			? { maxFilesChanged: r.maxFilesChanged }
			: {}),
	};
}
