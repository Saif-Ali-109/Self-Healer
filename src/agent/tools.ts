// The agent's toolbox. Every tool is confined to one worktree (sandbox.ts).
// `finish` / `give_up` are handled by the loop, not here.

import {
	existsSync,
	readFileSync,
	statSync,
	writeFileSync,
	mkdirSync,
	readdirSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { JsonSchema, ToolSpec } from "../llm/types.ts";
import type { AgentLimits } from "../settings.ts";
import {
	checkAgentCommand,
	isProtectedWritePath,
	relPath,
	resolveInside,
	runProcess,
	SandboxError,
	tailText,
} from "./sandbox.ts";

export const NOTE_KINDS = [
	"flaky_hint",
	"root_cause",
	"fix_recipe",
	"gotcha",
	"avoid",
	"test_info",
] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

const noteItem: JsonSchema = {
	type: "object",
	properties: {
		kind: {
			type: "string",
			enum: [...NOTE_KINDS],
			description: "What sort of takeaway this is.",
		},
		text: {
			type: "string",
			description:
				"One short, self-contained sentence a future run can act on.",
		},
		tags: {
			type: "array",
			items: { type: "string" },
			description: "Lowercase keywords (error names, tools, modules).",
		},
		files: {
			type: "array",
			items: { type: "string" },
			description: "Repo-relative paths the note is about.",
		},
	},
	required: ["kind", "text"],
};

export const TOOL_SPECS: ToolSpec[] = [
	{
		name: "list_dir",
		description:
			"List files and directories under a repo-relative path (skips .git and node_modules).",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Directory, default '.'" },
			},
		},
	},
	{
		name: "read_file",
		description:
			"Read a text file with line numbers. Use start_line/end_line for large files (max ~400 lines per call).",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string" },
				start_line: { type: "integer" },
				end_line: { type: "integer" },
			},
			required: ["path"],
		},
	},
	{
		name: "search",
		description:
			"Regex search (git grep -E) across tracked and untracked files. Returns file:line:match, max 100 hits.",
		parameters: {
			type: "object",
			properties: {
				pattern: { type: "string" },
				path: { type: "string", description: "Limit to this path" },
				ignore_case: { type: "boolean" },
			},
			required: ["pattern"],
		},
	},
	{
		name: "edit_file",
		description:
			"Replace old_str with new_str in a file. old_str must match exactly once unless replace_all is true.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string" },
				old_str: { type: "string" },
				new_str: { type: "string" },
				replace_all: { type: "boolean" },
			},
			required: ["path", "old_str", "new_str"],
		},
	},
	{
		name: "write_file",
		description:
			"Create or overwrite a file with the full content. Prefer edit_file for small changes.",
		parameters: {
			type: "object",
			properties: { path: { type: "string" }, content: { type: "string" } },
			required: ["path", "content"],
		},
	},
	{
		name: "run_command",
		description:
			"Run ONE command in the worktree (no shell: no pipes/&&/redirects). Allowed: package managers, test runners, linters, compilers, read-only git. Use it to reproduce the failure and to check your fix.",
		parameters: {
			type: "object",
			properties: {
				command: {
					type: "string",
					description: "e.g. 'npm test -- payment.spec.ts'",
				},
			},
			required: ["command"],
		},
	},
	{
		name: "finish",
		description:
			"Declare the fix complete. The harness then runs the FULL test suite (and configured checks) in the worktree; if anything fails you get the output back and must keep working. Only a passing run is pushed.",
		parameters: {
			type: "object",
			properties: {
				root_cause: {
					type: "string",
					description: "Why CI failed, in 1-3 sentences.",
				},
				summary: {
					type: "string",
					description: "What you changed and why (for the CI comment).",
				},
				rationale: {
					type: "string",
					description:
						"Your reasoning: evidence you gathered and alternatives you rejected. Recorded in the audit trail.",
				},
				confidence: {
					type: "number",
					description:
						"0..1 — how sure you are this fixes the root cause (not just the symptom).",
				},
				notes: {
					type: "array",
					items: noteItem,
					description: "0-3 durable takeaways about THIS repo for future runs.",
				},
			},
			required: ["root_cause", "summary", "rationale", "confidence"],
		},
	},
	{
		name: "give_up",
		description:
			"Stop without a fix when the failure needs a human (needs secrets/infra/product decision, cannot be reproduced, or fixing would mean weakening tests).",
		parameters: {
			type: "object",
			properties: {
				reason: { type: "string" },
				rationale: {
					type: "string",
					description:
						"What you tried and learned. Recorded in the audit trail.",
				},
				notes: { type: "array", items: noteItem },
			},
			required: ["reason", "rationale"],
		},
	},
];

export interface ToolEnv {
	root: string;
	env: Record<string, string>;
	limits: AgentLimits;
}

export interface ToolResult {
	output: string;
	isError: boolean;
}

const MAX_READ_LINES = 400;
const MAX_READ_CHARS = 24_000;
const MAX_TOOL_OUTPUT = 8_000;

function str(args: Record<string, unknown>, k: string): string {
	const v = args[k];
	if (typeof v !== "string")
		throw new SandboxError(`argument "${k}" must be a string`);
	return v;
}
function optInt(args: Record<string, unknown>, k: string): number | undefined {
	const v = args[k];
	return typeof v === "number" && Number.isFinite(v)
		? Math.trunc(v)
		: undefined;
}

export async function executeTool(
	env: ToolEnv,
	name: string,
	args: Record<string, unknown>,
): Promise<ToolResult> {
	try {
		if ("__parse_error" in args) {
			return {
				output:
					"tool arguments were not valid JSON; retry with well-formed arguments",
				isError: true,
			};
		}
		switch (name) {
			case "list_dir":
				return ok(
					listDir(env, typeof args.path === "string" ? args.path : "."),
				);
			case "read_file":
				return ok(
					readFile(
						env,
						str(args, "path"),
						optInt(args, "start_line"),
						optInt(args, "end_line"),
					),
				);
			case "search":
				return ok(
					await search(
						env,
						str(args, "pattern"),
						typeof args.path === "string" ? args.path : undefined,
						args.ignore_case === true,
					),
				);
			case "edit_file":
				return ok(
					editFile(
						env,
						str(args, "path"),
						str(args, "old_str"),
						str(args, "new_str"),
						args.replace_all === true,
					),
				);
			case "write_file":
				return ok(writeFile(env, str(args, "path"), str(args, "content")));
			case "run_command":
				return await runCommand(env, str(args, "command"));
			default:
				return { output: `unknown tool "${name}"`, isError: true };
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { output: msg, isError: true };
	}
}

function ok(output: string): ToolResult {
	return { output: tailText(output, MAX_TOOL_OUTPUT), isError: false };
}

function listDir(env: ToolEnv, path: string): string {
	const abs = resolveInside(env.root, path);
	if (!existsSync(abs) || !statSync(abs).isDirectory())
		throw new SandboxError(`not a directory: ${path}`);
	const lines: string[] = [];
	const walk = (dir: string, depth: number): void => {
		for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
			a.name.localeCompare(b.name),
		)) {
			if (e.name === ".git" || e.name === "node_modules") continue;
			const p = join(dir, e.name);
			lines.push(`${relPath(env.root, p)}${e.isDirectory() ? "/" : ""}`);
			if (lines.length >= 300) return;
			if (e.isDirectory() && depth < 1) walk(p, depth + 1);
		}
	};
	walk(abs, 0);
	return lines.length >= 300
		? `${lines.join("\n")}\n[truncated at 300 entries]`
		: lines.join("\n") || "(empty)";
}

function readFile(
	env: ToolEnv,
	path: string,
	start?: number,
	end?: number,
): string {
	const abs = resolveInside(env.root, path);
	if (!existsSync(abs) || !statSync(abs).isFile())
		throw new SandboxError(`not a file: ${path}`);
	const buf = readFileSync(abs);
	if (buf.subarray(0, 8000).includes(0))
		throw new SandboxError(`${path} looks binary`);
	const lines = buf.toString("utf8").split("\n");
	const from = Math.max(1, start ?? 1);
	const to = Math.min(
		lines.length,
		end ?? from + MAX_READ_LINES - 1,
		from + MAX_READ_LINES - 1,
	);
	let out = "";
	for (let i = from; i <= to; i++) {
		const line = `${i}\t${lines[i - 1]}\n`;
		if (out.length + line.length > MAX_READ_CHARS) {
			out += `[truncated at line ${i - 1}; request a smaller range]\n`;
			return out;
		}
		out += line;
	}
	if (to < lines.length)
		out += `[file has ${lines.length} lines; showing ${from}-${to}]\n`;
	return out || "(empty file)";
}

async function search(
	env: ToolEnv,
	pattern: string,
	path: string | undefined,
	ignoreCase: boolean,
): Promise<string> {
	const argv = [
		"git",
		"grep",
		"-n",
		"-I",
		"--untracked",
		"-E",
		...(ignoreCase ? ["-i"] : []),
		"-e",
		pattern,
	];
	if (path)
		argv.push("--", relPath(env.root, resolveInside(env.root, path)) || ".");
	const r = await runProcess(argv, {
		cwd: env.root,
		env: env.env,
		timeoutMs: 30_000,
		maxOutputBytes: 200_000,
	});
	if (r.code === 1) return "(no matches)";
	if (r.code !== 0)
		throw new SandboxError(`search failed: ${r.output.slice(0, 300)}`);
	const lines = r.output.split("\n").filter(Boolean);
	const clipped = lines
		.slice(0, 100)
		.map((l) => (l.length > 240 ? `${l.slice(0, 240)}…` : l));
	return lines.length > 100
		? `${clipped.join("\n")}\n[${lines.length - 100} more matches omitted]`
		: clipped.join("\n");
}

function guardWrite(env: ToolEnv, path: string): string {
	const abs = resolveInside(env.root, path);
	const rel = relPath(env.root, abs);
	if (isProtectedWritePath(rel))
		throw new SandboxError(`writing ${rel} is not allowed (protected path)`);
	return abs;
}

function editFile(
	env: ToolEnv,
	path: string,
	oldStr: string,
	newStr: string,
	all: boolean,
): string {
	const abs = guardWrite(env, path);
	if (!existsSync(abs))
		throw new SandboxError(`no such file: ${path} (use write_file to create)`);
	if (oldStr === "") throw new SandboxError("old_str must not be empty");
	const text = readFileSync(abs, "utf8");
	const count = text.split(oldStr).length - 1;
	if (count === 0)
		throw new SandboxError(
			"old_str not found — re-read the file; whitespace must match exactly",
		);
	if (count > 1 && !all)
		throw new SandboxError(
			`old_str matches ${count} places; add context to make it unique or set replace_all`,
		);
	writeFileSync(
		abs,
		all ? text.split(oldStr).join(newStr) : text.replace(oldStr, () => newStr),
	);
	return `edited ${relPath(env.root, abs)} (${all ? count : 1} replacement${count === 1 || !all ? "" : "s"})`;
}

function writeFile(env: ToolEnv, path: string, content: string): string {
	const abs = guardWrite(env, path);
	mkdirSync(dirname(abs), { recursive: true });
	const existed = existsSync(abs);
	writeFileSync(abs, content);
	return `${existed ? "overwrote" : "created"} ${relPath(env.root, abs)} (${content.split("\n").length} lines)`;
}

async function runCommand(env: ToolEnv, command: string): Promise<ToolResult> {
	const argv = checkAgentCommand(command);
	const r = await runProcess(argv, {
		cwd: env.root,
		env: env.env,
		timeoutMs: env.limits.commandTimeoutMs,
		wrapper: env.limits.commandWrapper,
	});
	const head = r.timedOut
		? `[timed out after ${Math.round(env.limits.commandTimeoutMs / 1000)}s]`
		: `[exit ${r.code} in ${(r.durationMs / 1000).toFixed(1)}s]`;
	return {
		output: tailText(`${head}\n${r.output}`, MAX_TOOL_OUTPUT),
		isError: r.code !== 0,
	};
}
