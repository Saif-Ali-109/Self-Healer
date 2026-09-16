// Unit tests for the import/type fixer's PURE detection/derivation layer.
// The shell layer (git worktree end-to-end) is covered by
// tests/integration/importfix_test.ts.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildImportLine,
	buildRelSpecifier,
	detectModuleSystem,
	extractMissingSymbol,
	findExporter,
	findFailingFile,
	insertImportAtTop,
	parseStackFrameCandidates,
} from "../../src/pipeline/fixscope/importfixer.ts";

const tempRoots: string[] = [];

async function tempTree(
	files: Record<string, string>,
): Promise<{ root: string }> {
	const root = await mkdtemp(join(tmpdir(), "importfixer-unit-"));
	tempRoots.push(root);
	for (const [rel, content] of Object.entries(files)) {
		const abs = join(root, rel);
		await mkdir(dirname(abs), { recursive: true });
		await writeFile(abs, content, "utf8");
	}
	return { root };
}

afterEach(async () => {
	for (const root of tempRoots.splice(0)) {
		await rm(root, { recursive: true, force: true }).catch(() => {});
	}
});

describe("extractMissingSymbol", () => {
	it("extracts the undefined symbol from an exact Node ReferenceError line", () => {
		expect(
			extractMissingSymbol(
				"##[error]ReferenceError: renderWidget is not defined",
			),
		).toBe("renderWidget");
	});

	it("handles $- and _-prefixed identifiers", () => {
		expect(extractMissingSymbol("ReferenceError: $bind is not defined")).toBe(
			"$bind",
		);
		expect(
			extractMissingSymbol("ReferenceError: _internal is not defined"),
		).toBe("_internal");
	});

	it("rejects non-ReferenceError lines and different bug classes", () => {
		expect(
			extractMissingSymbol("TypeError: renderWidget is not a function"),
		).toBeUndefined();
		expect(
			extractMissingSymbol("Error: Cannot find module './x.mjs'"),
		).toBeUndefined();
		expect(
			extractMissingSymbol("ReferenceError: something else"),
		).toBeUndefined();
		expect(extractMissingSymbol("no errors here")).toBeUndefined();
	});
});

describe("parseStackFrameCandidates", () => {
	it("maps file:// frames to repo-relative paths and strips runner prefixes", () => {
		const log = [
			"##[error]ReferenceError: renderWidget is not defined",
			"    at file:///home/runner/work/demo-repo/demo-repo/src/main.mjs:3:1",
			"    at file:///github/workspace/src/util.cjs:7:2",
			"    at file:///home/runner/work/o/r/packages/core/lib.ts:1:1",
		].join("\n");
		expect(parseStackFrameCandidates(log)).toEqual([
			"src/main.mjs",
			"src/util.cjs",
			"packages/core/lib.ts",
		]);
	});

	it("filters out node:internal frames and non-file frames", () => {
		const log = [
			"    at file:///home/runner/work/x/x/src/main.mjs:3:1",
			"    at ModuleJob.run (node:internal/modules/esm/module_job:271:25)",
			"    at async node:internal/process/task_queues:95:5",
			"    at processTicksAndRejections (node:internal/process/task_queues:95:5)",
		].join("\n");
		expect(parseStackFrameCandidates(log)).toEqual(["src/main.mjs"]);
	});
});

describe("findFailingFile", () => {
	it("validates a stack-frame candidate that references the symbol", async () => {
		const { root } = await tempTree({
			"src/main.mjs": "const el = renderWidget();\n",
			"src/renderer.mjs": "export function renderWidget() {\n  return 1;\n}\n",
		});
		expect(findFailingFile(root, "renderWidget", ["src/main.mjs"])).toBe(
			"src/main.mjs",
		);
	});

	it("skips a candidate that imports the symbol, then falls back to the lone usage file", async () => {
		const { root } = await tempTree({
			"src/entry.mjs":
				'import { renderWidget } from "./renderer.mjs";\nrenderWidget();\n',
			"src/renderer.mjs": "export function renderWidget() {\n  return 1;\n}\n",
			"src/app.mjs": "const el = renderWidget();\nconsole.log(el);\n",
		});
		expect(findFailingFile(root, "renderWidget", ["src/entry.mjs"])).toBe(
			"src/app.mjs",
		);
	});

	it("bails when no candidate exists and usage is only dot-qualified", async () => {
		const { root } = await tempTree({
			"src/math.js": "const double = (n) => math.add(n, n);\n",
		});
		// `math.add` must NOT count as a bare use of `add`.
		expect(findFailingFile(root, "add", [])).toBeUndefined();
	});

	it("fallback requires exactly one bare-token usage hit", async () => {
		const { root } = await tempTree({
			"src/app.js": "const r = add(1, 2);\nconsole.log(r);\n",
			"src/math.js": "const d = math.add(1, 2);\n",
		});
		expect(findFailingFile(root, "add", [])).toBe("src/app.js");
	});

	it("fallback bails when two files both use the symbol bare", async () => {
		const { root } = await tempTree({
			"src/a.js": "add(1, 2);\n",
			"src/b.js": "add(2, 3);\n",
		});
		expect(findFailingFile(root, "add", [])).toBeUndefined();
	});
});

describe("findExporter", () => {
	it("locates the exporter among the supported named forms", async () => {
		const { root } = await tempTree({
			"src/a.mjs": "export function widgetFn() { return 1; }\n",
			"src/b.mjs": "export const widgetConst = 1;\n",
			"src/c.mjs": "export let widgetLet = 1;\n",
			"src/d.mjs": "export var widgetVar = 1;\n",
			"src/e.mjs": "export class WidgetClass {}\n",
			"src/f.mjs": "export async function widgetAsync() { return 1; }\n",
			"src/g.mjs": "export default function widgetDefault() { return 1; }\n",
			"src/h.mjs": "const internal = 1;\nexport { internal as widgetAlias };\n",
		});
		const expectations: Record<string, string> = {
			widgetFn: "src/a.mjs",
			widgetConst: "src/b.mjs",
			widgetLet: "src/c.mjs",
			widgetVar: "src/d.mjs",
			WidgetClass: "src/e.mjs",
			widgetAsync: "src/f.mjs",
			widgetDefault: "src/g.mjs",
			widgetAlias: "src/h.mjs",
		};
		for (const [symbol, file] of Object.entries(expectations)) {
			expect(findExporter(root, symbol)).toEqual({
				ok: true,
				exporter: { file, exportName: symbol },
			});
		}
	});

	it("rejects type-only exports, barrels, and renamed aliases", async () => {
		const { root } = await tempTree({
			"src/t.mjs": "export type WidgetType = { x: number };\n",
			"src/i.mjs": "export interface WidgetIface { x: number }\n",
			"src/barrel.mjs": "export * from './not-here.mjs';\n",
			"src/r.mjs":
				"const widgetLocal = 1;\nexport { widgetLocal as otherName };\n",
		});
		expect(findExporter(root, "WidgetType")).toEqual({
			ok: false,
			reason: "no_exporter",
		});
		expect(findExporter(root, "WidgetIface")).toEqual({
			ok: false,
			reason: "no_exporter",
		});
		// A `export *` barrel never counts as an exporter.
		expect(findExporter(root, "someBarrelName")).toEqual({
			ok: false,
			reason: "no_exporter",
		});
		// The importable name is `otherName`, not the local binding.
		expect(findExporter(root, "widgetLocal")).toEqual({
			ok: false,
			reason: "no_exporter",
		});
	});

	it("bails with no_exporter when nothing exports the symbol", async () => {
		const { root } = await tempTree({
			"src/a.mjs": "const x = 1;\nconsole.log(x);\n",
		});
		expect(findExporter(root, "renderWidget")).toEqual({
			ok: false,
			reason: "no_exporter",
		});
	});

	it("bails with multiple_exporters when two files export the same symbol", async () => {
		const { root } = await tempTree({
			"src/a.mjs": "export function widgetDup() { return 1; }\n",
			"src/b.mjs": "export const widgetDup = 2;\n",
		});
		expect(findExporter(root, "widgetDup")).toEqual({
			ok: false,
			reason: "multiple_exporters",
		});
	});
});

describe("buildImportLine / buildRelSpecifier", () => {
	it('emits `import { S } from "<specifier>";`', () => {
		expect(buildImportLine("renderWidget", "./renderer.mjs")).toBe(
			'import { renderWidget } from "./renderer.mjs";',
		);
	});

	it("computes on-disk posix relative specifiers with a leading ./", () => {
		expect(buildRelSpecifier("src/main.mjs", "src/renderer.mjs")).toBe(
			"./renderer.mjs",
		);
		expect(buildRelSpecifier("main.mjs", "src/renderer.mjs")).toBe(
			"./src/renderer.mjs",
		);
		expect(buildRelSpecifier("src/main.mjs", "renderer.mjs")).toBe(
			"../renderer.mjs",
		);
	});
});

describe("insertImportAtTop", () => {
	it("inserts at index 0 with blank-line separation", () => {
		expect(
			insertImportAtTop(
				"export const a = 1;\n",
				'import { a } from "./a.mjs";',
			),
		).toBe('import { a } from "./a.mjs";\n\nexport const a = 1;\n');
	});

	it("inserts after a shebang line", () => {
		expect(
			insertImportAtTop(
				"#!/usr/bin/env node\nconsole.log(1);\n",
				'import { a } from "./a.mjs";',
			),
		).toBe(
			'#!/usr/bin/env node\nimport { a } from "./a.mjs";\n\nconsole.log(1);\n',
		);
	});

	it("keeps a leading comment header with blank-line separation", () => {
		expect(
			insertImportAtTop(
				"// fixture header\nconst a = 1;\n",
				'import { a } from "./a.mjs";',
			),
		).toBe('import { a } from "./a.mjs";\n\n// fixture header\nconst a = 1;\n');
	});
});

describe("detectModuleSystem", () => {
	it("classes .mjs as ESM and .cjs as CJS by extension", async () => {
		const { root } = await tempTree({
			"src/a.mjs": "export const a = 1;\n",
			"src/b.cjs": "module.exports = {};\n",
		});
		expect(detectModuleSystem(root, "src/a.mjs")).toBe("esm");
		expect(detectModuleSystem(root, "src/b.cjs")).toBe("cjs");
	});

	it("honors the nearest package.json type for .js files", async () => {
		const { root } = await tempTree({
			"package.json": '{"type":"module"}',
			"src/a.js": "export const a = 1;\n",
			"src/b.js": "module.exports = {};\n",
		});
		expect(detectModuleSystem(root, "src/a.js")).toBe("esm");
		expect(detectModuleSystem(root, "src/b.js")).toBe("esm");

		const { root: cjsRoot } = await tempTree({
			"package.json": '{"type":"commonjs"}',
			"src/c.js": "const r = require('x');\n",
			"src/d.js": "export const d = 1;\n",
		});
		expect(detectModuleSystem(cjsRoot, "src/c.js")).toBe("cjs");
		expect(detectModuleSystem(cjsRoot, "src/d.js")).toBe("cjs");
	});

	it("falls back to syntax sniffing without a package.json, then CJS", async () => {
		const { root } = await tempTree({
			"a.js": "import x from './x.mjs';\n",
			"b.js": "const x = require('x');\n",
			"c.js": "console.log('plain');\n",
		});
		expect(detectModuleSystem(root, "a.js")).toBe("esm");
		expect(detectModuleSystem(root, "b.js")).toBe("cjs");
		expect(detectModuleSystem(root, "c.js")).toBe("cjs");
	});
});
