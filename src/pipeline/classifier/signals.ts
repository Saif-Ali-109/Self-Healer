import type { CiCategory } from "../../types.ts";

export interface SignalMatch {
	signal: string;
	detail: string;
	category: CiCategory;
	strength: "strong" | "moderate";
}

/**
 * Known flaky signals — log patterns suggesting an intermittent failure.
 * Each entry is a regex to test against job log output.
 */
const FLAKY_SIGNALS: Array<{
	pattern: RegExp;
	signal: string;
	strength: SignalMatch["strength"];
}> = [
	{
		pattern: /timeout|timed?\s*out|deadline\s+exceeded/i,
		signal: "timeout_pattern",
		strength: "strong",
	},
	{
		pattern:
			/ECONNRESET|EPIPE|ETIMEDOUT|connection\s+(reset|refused|timed?\s*out)/i,
		signal: "connection_reset",
		strength: "strong",
	},
	{
		pattern: /race\s+condition|flaky|intermittent|sometimes\s+fails/i,
		signal: "known_flaky_history",
		strength: "strong",
	},
	{
		pattern: /OOM|out\s+of\s+memory|heap\s+out/i,
		signal: "oom_pattern",
		strength: "moderate",
	},
	{
		pattern: /signal\s+killed|SIGKILL|SIGTERM/i,
		signal: "process_killed",
		strength: "moderate",
	},
	{
		pattern: /port\s+\d+\s+(already|in\s+use)/i,
		signal: "port_in_use",
		strength: "moderate",
	},
];

/**
 * Known infra signals — infrastructure problems, not code bugs.
 */
const INFRA_SIGNALS: Array<{
	pattern: RegExp;
	signal: string;
	strength: SignalMatch["strength"];
}> = [
	{
		// Bare `429` must NOT match alone — GitHub Actions writes random temp
		// UUIDs like `_temp/27bc7100-1591-4291-bd6e-...` into job logs, which
		// live-test surfaced as a false positive (lint failure misread as infra).
		pattern:
			/rate\s*limit|too\s*many\s*requests|429\s+too\s+many|(?:http|status(?:\s+code)?)\s*[:\s]*\s*429/i,
		signal: "rate_limit",
		strength: "strong",
	},
	{
		pattern: /disk\s+full|no\s+space\s+left/i,
		signal: "disk_full",
		strength: "strong",
	},
	{
		pattern: /docker\s+pull|manifest\s+unknown|image\s+not\s+found/i,
		signal: "docker_pull_failure",
		strength: "strong",
	},
	{
		// Same rule as rate_limit: require HTTP-ish context for the status code.
		pattern:
			/expired|unauthorized|invalid\s+(?:credentials?|token|auth)|authentication\s+failed|401\s+unauthorized|(?:http|status(?:\s+code)?)\s*[:\s]*\s*401/i,
		signal: "expired_credentials",
		strength: "strong",
	},
	{
		pattern:
			/service\s+unavailable|503\s+service\b|ECONNREFUSED.*registry|(?:http|status(?:\s+code)?)\s*[:\s]*\s*503/i,
		signal: "service_unavailable",
		strength: "moderate",
	},
	{
		pattern: /ENOSPC|EMFILE|too\s+many\s+open/i,
		signal: "system_resource_exhausted",
		strength: "moderate",
	},
];

/**
 * Scan log text against signal patterns. Returns all matches.
 */
export function detectSignals(logText: string): SignalMatch[] {
	const matches: SignalMatch[] = [];
	for (const s of FLAKY_SIGNALS) {
		if (s.pattern.test(logText)) {
			matches.push({
				signal: s.signal,
				detail: `Log matches pattern: ${s.pattern.source}`,
				category: "flaky",
				strength: s.strength,
			});
		}
	}
	for (const s of INFRA_SIGNALS) {
		if (s.pattern.test(logText)) {
			matches.push({
				signal: s.signal,
				detail: `Log matches pattern: ${s.pattern.source}`,
				category: "infra",
				strength: s.strength,
			});
		}
	}
	return matches;
}

/**
 * Determine classification category and base confidence from signal matches.
 * Rule-first: strong signal → 0.9, moderate → 0.75, conflicting → 0.5.
 */
export function classifyFromSignals(signals: SignalMatch[]): {
	category: CiCategory;
	confidence: number;
	evidence: Array<{ signal: string; detail: string }>;
} {
	if (signals.length === 0) {
		return {
			category: "real_bug",
			confidence: 0.9,
			evidence: [
				{
					signal: "no_signal_match",
					detail: "No flaky or infra signals detected; classified as real_bug",
				},
			],
		};
	}

	const byCategory = {
		flaky: signals.filter((s) => s.category === "flaky"),
		infra: signals.filter((s) => s.category === "infra"),
		real_bug: [] as SignalMatch[],
	};

	// Dominant category
	if (byCategory.infra.length > 0) {
		const best =
			byCategory.infra.find((s) => s.strength === "strong") ??
			byCategory.infra[0]!;
		return {
			category: "infra",
			confidence: best.strength === "strong" ? 0.9 : 0.75,
			evidence: signals.map((s) => ({ signal: s.signal, detail: s.detail })),
		};
	}
	if (byCategory.flaky.length > 0) {
		const best =
			byCategory.flaky.find((s) => s.strength === "strong") ??
			byCategory.flaky[0]!;
		return {
			category: "flaky",
			confidence: best.strength === "strong" ? 0.9 : 0.75,
			evidence: signals.map((s) => ({ signal: s.signal, detail: s.detail })),
		};
	}

	// No signals — real_bug
	return {
		category: "real_bug",
		confidence: 0.9,
		evidence: signals.map((s) => ({ signal: s.signal, detail: s.detail })),
	};
}
