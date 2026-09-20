// Package-root resolution, shared by modules that read packaged assets
// (migrations/, .env.example, assets/) so they work identically:
//   - in the repo at dev time (tsx): this file lives at src/paths.ts,
//   - in the bundled dist/ (self-healer.mjs, daemon.mjs): one level below root,
//   - installed globally under node_modules (bin/self-healer.mjs sets
//     SELF_HEALER_PKG, which wins over the fallback).

import { join } from "node:path";
import { fileURLToPath } from "node:url";

export function packageRoot(): string {
	const pinned = process.env.SELF_HEALER_PKG;
	if (pinned) return pinned;
	// Fallback: this module is always one level below the package root —
	// src/paths.ts at dev time, dist/<bundle>.mjs when bundled. One "..".
	return fileURLToPath(new URL("..", import.meta.url));
}

export function packagePath(...parts: string[]): string {
	return join(packageRoot(), ...parts);
}
