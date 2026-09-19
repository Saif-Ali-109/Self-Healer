#!/usr/bin/env node
// Self-Healer CI agent CLI. Loads the esbuild-bundled dist/self-healer.mjs
// (plain JS — works under node_modules, zero runtime dependencies).
import { fileURLToPath } from "node:url";

// Pin the package root so bundled modules can find migrations/ + assets/.
process.env.SELF_HEALER_PKG = fileURLToPath(new URL("..", import.meta.url));

await import(new URL("../dist/self-healer.mjs", import.meta.url));