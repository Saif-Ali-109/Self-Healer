// Package-root resolution, shared by modules that read packaged assets
// (migrations/, .env.example, assets/) so they work identically:
//   - in the repo at dev time (tsx, depth-2 source files),
//   - in the bundled dist/ (depth-1, run via bin/self-healer.mjs),
//   - installed globally under node_modules (bin sets SELF_HEALER_PKG).

import { fileURLToPath } from "node:url";
import { join } from "node:path";

export function packageRoot(): string {
	const pinned = process.env.SELF_HEALER_PKG;
	if (pinned) return pinned;
	// Fallback for source runs: src/<dir>/<file>.ts → package root.
	return fileURLToPath(new URL("../..", import.meta.url));
}

export function packagePath(...parts: string[]): string {
	return join(packageRoot(), ...parts);
}