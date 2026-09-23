// CLI argument parsing (US6) — pure, side-effect free, unit-tested.
// `self-healer enable --repo o/r` accepts both `--repo o/r` and `--repo=o/r`.

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export interface CliArgs {
	command: string;
	/** Second positional (e.g. `notes list`, `llm show`). */
	sub: string | undefined;
	/** Value of a `--name value` / `--name=value` flag, when present. */
	flag: (name: string) => string | undefined;
	force: boolean;
	foreground: boolean;
	repo: string | undefined;
	repoValid: boolean;
}

/** Parse raw argv (process.argv.slice(2)) into a dispatchable invocation. */
export function parseCliArgs(args: string[]): CliArgs {
	const command = args[0] ?? "help";
	let repo: string | undefined;
	if (command === "enable" || command === "notes" || command === "llm") {
		const flagIdx = args.findIndex(
			(a) => a === "--repo" || a.startsWith("--repo="),
		);
		const flag = flagIdx >= 0 ? args[flagIdx] : undefined;
		if (flag !== undefined) {
			// args[flagIdx + 1] is string | undefined under noUncheckedIndexedAccess —
			// exactly repo's type, so no non-null assertion is needed.
			repo = flag.startsWith("--repo=")
				? flag.slice("--repo=".length)
				: args[flagIdx + 1];
		}
	}
	const flag = (name: string): string | undefined => {
		const i = args.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
		const a = i >= 0 ? args[i] : undefined;
		if (a === undefined) return undefined;
		return a.startsWith(`--${name}=`) ? a.slice(name.length + 3) : args[i + 1];
	};
	const second = args[1];
	return {
		command,
		sub: second && !second.startsWith("-") ? second : undefined,
		flag,
		force: args.includes("--force"),
		foreground: args.includes("--foreground"),
		repo,
		repoValid: repo !== undefined && REPO_RE.test(repo),
	};
}
