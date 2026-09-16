export interface AllowlistEntry {
	id: string; // e.g. "lint/format"
	description: string;
	detect: (logText: string) => boolean; // true if this pattern matches the failure
	verifyCommand: string; // shell command to verify the fix works
}

/**
 * MVP fixable-pattern allowlist.
 * Only "lint/format" is active; others return false (post-MVP).
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
		verifyCommand: "npx @biomejs/biome check --write .",
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
			"Missing/incorrect import or type error with obvious single-line fix (post-MVP)",
		detect: () => false,
		verifyCommand: "",
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
