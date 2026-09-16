// T017 — classifier signals + confidence scoring (contracts/classification.md)

import { describe, expect, it } from "vitest";
import { stripLogTimestamps } from "../../src/pipeline/classifier/index.ts";
import {
	classifyFromSignals,
	detectSignals,
	type SignalMatch,
} from "../../src/pipeline/classifier/signals.ts";

function signal(
	category: SignalMatch["category"],
	signalName: string,
	strength: SignalMatch["strength"],
): SignalMatch {
	return { signal: signalName, detail: "test", category, strength };
}

describe("detectSignals", () => {
	it("flags a timeout as a strong flaky signal", () => {
		const matches = detectSignals("test hung until timeout after 30s");
		expect(
			matches.some(
				(m) => m.category === "flaky" && m.signal === "timeout_pattern",
			),
		).toBe(true);
	});

	it("flags a connection reset as flaky", () => {
		const matches = detectSignals("Error: ECONNRESET reading from socket");
		expect(
			matches.some(
				(m) => m.category === "flaky" && m.signal === "connection_reset",
			),
		).toBe(true);
	});

	it("flags a rate limit as a strong infra signal", () => {
		const matches = detectSignals("HTTP 429: rate limit exceeded");
		expect(
			matches.some((m) => m.category === "infra" && m.signal === "rate_limit"),
		).toBe(true);
	});

	it("flags disk full as infra", () => {
		const matches = detectSignals("ENOSPC: no space left on device");
		expect(matches.some((m) => m.category === "infra")).toBe(true);
	});

	it("returns no signals for a generic failure", () => {
		expect(detectSignals("Expected 'x' but received 'y' in widget.test.ts")).toEqual(
			[],
		);
	});
});

describe("stripLogTimestamps", () => {
	it("removes ISO timestamp prefixes and the BOM", () => {
		const raw =
			"\uFEFF2026-09-16T14:05:26.3140171Z ##[error]File content differs\n2026-09-16T14:05:27.0000000Z   at foo.ts:1:2\nplain line";
		expect(stripLogTimestamps(raw)).toBe(
			"##[error]File content differs\nat foo.ts:1:2\nplain line",
		);
	});

	it("no longer trips infra signals via digits inside timestamps", () => {
		// The microseconds in this timestamp contain `401`; the UTF-8 BOM and the
		// `token: ***` line must not create a false infra classification.
		const raw =
			"\uFEFF2026-09-16T14:05:26.3140171Z ##[group]GITHUB_TOKEN Permissions\n2026-09-16T14:05:26.3140171Z   token: ***\n2026-09-16T14:05:26.3140171Z ##[error]File content differs from formatting output";
		const signals = detectSignals(stripLogTimestamps(raw));
		expect(signals.filter((s) => s.category === "infra")).toEqual([]);
		expect(signals).toEqual([]);
	});
});

describe("classifyFromSignals", () => {
	it("strong flaky signal → flaky with confidence 0.9", () => {
		const r = classifyFromSignals([
			signal("flaky", "timeout_pattern", "strong"),
		]);
		expect(r.category).toBe("flaky");
		expect(r.confidence).toBe(0.9);
		expect(r.evidence.length).toBeGreaterThan(0);
	});

	it("moderate-only signal → same category with confidence 0.75", () => {
		const r = classifyFromSignals([signal("flaky", "port_in_use", "moderate")]);
		expect(r.category).toBe("flaky");
		expect(r.confidence).toBe(0.75);
	});

	it("strong infra signal → infra with confidence 0.9 (infra wins over flaky)", () => {
		const r = classifyFromSignals([
			signal("flaky", "timeout_pattern", "strong"),
			signal("infra", "rate_limit", "strong"),
		]);
		expect(r.category).toBe("infra");
		expect(r.confidence).toBe(0.9);
	});

	it("no signals → real_bug at 0.9 with evidence of no match", () => {
		const r = classifyFromSignals([]);
		expect(r.category).toBe("real_bug");
		expect(r.confidence).toBe(0.9);
		expect(r.evidence[0]?.signal).toBe("no_signal_match");
	});
});
