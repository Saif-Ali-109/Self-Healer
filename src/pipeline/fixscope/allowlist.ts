export interface AllowlistEntry {
	id: string; // e.g. "lint/format"
	description: string;
	detect: (logText: string) => boolean; // true if this pattern matches the failure
	verifyCommand: string; // the command executed in the worktree after the fix; exit 0 verifies it (also used in comments/PR text)
	rootCause?: string; // human-readable root-cause line used in the fix comment
}

/**
 * Fixable-pattern allowlist.
 * Active: "lint/format", "import/type". Stubs (detect() === false, post-MVP):
 * "snapshot", "timeout".
 */
const ENTRIES: AllowlistEntry[] = [
	{
		id: "lint/format",
		description:
			"Linter/formatter failure (biome, eslint, prettier) with fixable diagnostics",
		detect: (log: string) =>
			/lint\s+error|formatting?\s+error|prettier|biome\s+check|eslint|expected\s+.*but\s+received/i.test(
				log,
			),
		verifyCommand: "npx @biomejs/biome check .",
		rootCause: "Lint/format issues detected in the failing job.",
	},
	{
		id: "snapshot",
		description: "Outdated snapshot/golden file mismatch (post-MVP)",
		detect: () => false,
		verifyCommand: "",
	},
	{
		id: "import/type",
		description:
			"Missing import — a symbol referenced but not imported (`ReferenceError: X is not defined`) with a deterministic single-line fix",
		detect: (log: string) =>
			/ReferenceError:\s+[A-Za-z_$][A-Za-z0-9_$]*\s+is not defined/.test(log),
		verifyCommand: "node src/main.mjs",
		rootCause:
			"A symbol referenced in the failing job is not imported (`ReferenceError: X is not defined`).",
	},
	{
		id: "timeout",
		description:
			"Test timeout too low for a legitimately slower operation (post-MVP)",
		detect: () => false,
		verifyCommand: "",
	},
];

/** All registered allowlist entries. */
export function getAllowlist(): ReadonlyArray<AllowlistEntry> {
	return ENTRIES;
}

/**
 * Find the first allowlist entry that matches the failure log.
 * Returns undefined if no pattern matches (→ escalate with 'no_pattern_match').
 */
export function matchPattern(logText: string): AllowlistEntry | undefined {
	return ENTRIES.find((e) => e.detect(logText));
}
