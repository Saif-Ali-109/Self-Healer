// The agent loop: model ⇄ tools until finish / give_up / budget / error.
// Provider-neutral (LlmClient) and DB-free (the caller injects `trace`), so it
// is fully testable with a scripted fake model.

import type { ChatMessage, LlmClient, ToolCall } from "../llm/types.ts";
import { LlmError } from "../llm/types.ts";
import type { AgentLimits } from "../settings.ts";
import type { PipelineBudget } from "../utils/budget.ts";
import {
	executeTool,
	type NoteKind,
	TOOL_SPECS,
	type ToolEnv,
} from "./tools.ts";
import type { NoteInput } from "../memory/notes.ts";

export interface FinishArgs {
	root_cause: string;
	summary: string;
	rationale: string;
	confidence: number;
	notes: NoteInput[];
}

export interface GiveUpArgs {
	reason: string;
	rationale: string;
	notes: NoteInput[];
}

export type AgentOutcome =
	| { status: "finished"; finish: FinishArgs; feedback: string }
	| { status: "gave_up"; give_up: GiveUpArgs }
	| { status: "budget"; detail: string; notes: NoteInput[] }
	| { status: "llm_error"; detail: string; notes: NoteInput[] }
	| { status: "rejected"; detail: string; notes: NoteInput[] };

export interface FinishVerdict {
	accepted: boolean;
	/** Sent back to the model when rejected; recorded when accepted. */
	feedback: string;
}

export type TraceFn = (
	kind: "ci_agent_reasoning" | "ci_agent_tool" | "ci_agent_decision",
	payload: Record<string, unknown>,
	tool?: { name: string; input?: unknown; output?: unknown },
) => Promise<void>;

export interface LoopInput {
	llm: LlmClient;
	system: string;
	task: string;
	toolEnv: ToolEnv;
	limits: AgentLimits;
	budget: PipelineBudget;
	temperature?: number | undefined;
	onFinish: (args: FinishArgs) => Promise<FinishVerdict>;
	trace: TraceFn;
	maxFinishRejections?: number;
}

function asNotes(v: unknown): NoteInput[] {
	if (!Array.isArray(v)) return [];
	const out: NoteInput[] = [];
	for (const n of v.slice(0, 3)) {
		if (
			n &&
			typeof n === "object" &&
			typeof (n as { text?: unknown }).text === "string"
		) {
			const o = n as {
				kind?: unknown;
				text: string;
				tags?: unknown;
				files?: unknown;
			};
			out.push({
				kind: typeof o.kind === "string" ? (o.kind as NoteKind) : "gotcha",
				text: o.text,
				tags: Array.isArray(o.tags) ? o.tags.map(String) : undefined,
				files: Array.isArray(o.files) ? o.files.map(String) : undefined,
			});
		}
	}
	return out;
}

function s(v: unknown): string {
	return typeof v === "string" ? v : "";
}

function parseFinish(a: Record<string, unknown>): FinishArgs | string {
	const root_cause = s(a.root_cause).trim();
	const summary = s(a.summary).trim();
	const rationale = s(a.rationale).trim();
	const confidence =
		typeof a.confidence === "number" ? a.confidence : Number.NaN;
	if (!root_cause || !summary || !rationale)
		return "finish requires non-empty root_cause, summary, and rationale";
	if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)
		return "finish requires confidence between 0 and 1";
	return {
		root_cause,
		summary,
		rationale,
		confidence,
		notes: asNotes(a.notes),
	};
}

function contextChars(messages: ChatMessage[]): number {
	let n = 0;
	for (const m of messages)
		n +=
			m.content.length +
			(m.role === "assistant" ? JSON.stringify(m.toolCalls ?? []).length : 0);
	return n;
}

/** Elide the oldest tool outputs once the conversation gets too large. */
export function compactContext(
	messages: ChatMessage[],
	maxChars: number,
): void {
	if (contextChars(messages) <= maxChars) return;
	const toolIdx = messages
		.map((m, i) => (m.role === "tool" ? i : -1))
		.filter((i) => i >= 0);
	for (const i of toolIdx.slice(0, Math.max(0, toolIdx.length - 8))) {
		const m = messages[i];
		if (m && m.role === "tool" && m.content.length > 200) {
			m.content =
				"[older tool output elided to save context — re-run the tool if you need it]";
			if (contextChars(messages) <= maxChars) return;
		}
	}
}

export async function runAgentLoop(inp: LoopInput): Promise<AgentOutcome> {
	const messages: ChatMessage[] = [{ role: "user", content: inp.task }];
	const maxRejections = inp.maxFinishRejections ?? 3;
	let toolCalls = 0;
	let nudges = 0;
	let rejections = 0;
	let step = 0;
	const pendingNotes: NoteInput[] = [];

	for (;;) {
		if (inp.budget.isExpired())
			return {
				status: "budget",
				detail: "pipeline time budget exhausted",
				notes: pendingNotes,
			};
		if (!inp.budget.tickLlm())
			return {
				status: "budget",
				detail: `model-call budget exhausted (${inp.limits.maxLlmCalls} calls)`,
				notes: pendingNotes,
			};
		step++;
		compactContext(messages, inp.limits.maxContextChars);

		let resp: Awaited<ReturnType<LlmClient["chat"]>>;
		try {
			resp = await inp.llm.chat({
				system: inp.system,
				messages,
				tools: TOOL_SPECS,
				temperature: inp.temperature,
				signal: AbortSignal.timeout(Math.max(5_000, inp.budget.remainingMs())),
			});
		} catch (err) {
			const detail = err instanceof LlmError ? err.message : String(err);
			return { status: "llm_error", detail, notes: pendingNotes };
		}

		await inp.trace("ci_agent_reasoning", {
			step,
			provider: inp.llm.provider,
			model: inp.llm.model,
			text: resp.text,
			tool_calls: resp.toolCalls.map((c) => c.name),
			input_tokens: resp.usage?.inputTokens,
			output_tokens: resp.usage?.outputTokens,
		});

		messages.push({
			role: "assistant",
			content: resp.text,
			...(resp.toolCalls.length > 0 ? { toolCalls: resp.toolCalls } : {}),
			...(resp.raw !== undefined ? { raw: resp.raw } : {}),
		});

		if (resp.toolCalls.length === 0) {
			nudges++;
			if (nudges > 2) {
				return {
					status: "gave_up",
					give_up: {
						reason: "the model stopped calling tools without finishing",
						rationale: resp.text.slice(0, 1500) || "(no text)",
						notes: pendingNotes,
					},
				};
			}
			messages.push({
				role: "user",
				content:
					"You must respond with a tool call. Continue investigating, or call finish (with a fix) or give_up.",
			});
			continue;
		}
		nudges = 0;

		let terminal: AgentOutcome | null = null;
		for (const call of resp.toolCalls) {
			const result = await handleCall(call);
			messages.push({
				role: "tool",
				toolCallId: call.id,
				name: call.name,
				content: result.content,
			});
			if (result.terminal && !terminal) terminal = result.terminal;
		}
		if (terminal) return terminal;

		async function handleCall(
			call: ToolCall,
		): Promise<{ content: string; terminal?: AgentOutcome }> {
			if (call.name === "give_up") {
				const g: GiveUpArgs = {
					reason: s(call.args.reason) || "(no reason given)",
					rationale: s(call.args.rationale),
					notes: asNotes(call.args.notes),
				};
				await inp.trace("ci_agent_decision", {
					decision: "give_up",
					reason: g.reason,
					rationale: g.rationale,
				});
				return {
					content: "acknowledged",
					terminal: { status: "gave_up", give_up: g },
				};
			}
			if (call.name === "finish") {
				const parsed = parseFinish(call.args);
				if (typeof parsed === "string")
					return { content: `finish rejected: ${parsed}` };
				pendingNotes.push(...parsed.notes);
				const verdict = await inp.onFinish(parsed);
				await inp.trace("ci_agent_decision", {
					decision: verdict.accepted ? "finish_accepted" : "finish_rejected",
					root_cause: parsed.root_cause,
					summary: parsed.summary,
					rationale: parsed.rationale,
					confidence: parsed.confidence,
					feedback: verdict.feedback,
				});
				if (verdict.accepted) {
					return {
						content: "accepted",
						terminal: {
							status: "finished",
							finish: parsed,
							feedback: verdict.feedback,
						},
					};
				}
				rejections++;
				if (rejections >= maxRejections) {
					return {
						content: `finish rejected: ${verdict.feedback}`,
						terminal: {
							status: "rejected",
							detail: verdict.feedback,
							notes: pendingNotes,
						},
					};
				}
				return {
					content: `finish rejected — ${verdict.feedback}\nKeep working (attempt ${rejections}/${maxRejections}), then call finish again.`,
				};
			}
			toolCalls++;
			if (toolCalls > inp.limits.maxToolCalls) {
				return {
					content: "tool budget exhausted",
					terminal: {
						status: "budget",
						detail: `tool-call budget exhausted (${inp.limits.maxToolCalls})`,
						notes: pendingNotes,
					},
				};
			}
			const r = await executeTool(inp.toolEnv, call.name, call.args);
			await inp.trace(
				"ci_agent_tool",
				{ step, is_error: r.isError },
				{ name: call.name, input: call.args, output: r.output },
			);
			return { content: r.isError ? `ERROR: ${r.output}` : r.output };
		}
	}
}
