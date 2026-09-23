// Probe OpenRouter free model pools for availability.
// Run via: npm run llm:probe -- [model …]
// Uses OPENROUTER_API_KEY from process.env (loaded by the npm-script loader).
// Prints ONLY model id + HTTP status / outcome — never keys or headers.
const key = process.env.OPENROUTER_API_KEY;
if (!key) {
  console.error("[probe] OPENROUTER_API_KEY not set; refusing to run.");
  process.exit(2);
}

const DEFAULT_SPECS = [
  "qwen/qwen3.8-27b:free",
  "google/gemma-4-26b-a4b-it:free",
  "cohere/north-mini-code:free",
  "thinkingmachines/inkling:free",
  "thinkingmachines/inkling-small:free",
  "poolside/laguna-s-2.1:free",
  "poolside/laguna-xs-2.1:free",
  "inclusionai/ling-3.0-flash-fin:free",
  "nex-agi/nex-n2.5-mini:free",
  "dots-studio/dots-3-note-preview:free",
  "nvidia/nemotron-3.5-lightning:free",
  "liquid/lfm-2.5-2.6b:free",
];

const models = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_SPECS;

const TOOLS = [
  {
    type: "function",
    function: {
      name: "probe",
      description: "Probe function to verify tool calling works.",
      parameters: { type: "object", properties: { ok: { type: "boolean" } } },
    },
  },
];

async function probe(model: string): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 32,
        messages: [{ role: "user", content: "Reply with exactly: OK" }],
        tools: TOOLS,
        tool_choice: "auto",
      }),
    });
    const status = res.status;
    if (!res.ok) {
      const txt = (await res.text()).slice(0, 140);
      return `HTTP ${status} ${txt.replace(/\s+/g, " ").slice(0, 110)}`;
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string | null; tool_calls?: unknown } }>;
    };
    const msg = data.choices?.[0]?.message;
    const gotTool = Array.isArray(msg?.tool_calls) && msg!.tool_calls!.length > 0;
    const content = (msg?.content ?? "").trim().slice(0, 20);
    if (gotTool) return `HTTP 200 OK (tool_call)`;
    if (content) return `HTTP 200 OK content="${content}"`;
    return "HTTP 200 OK (empty)";
  } catch (err) {
    return `ERR ${err instanceof Error ? err.message.slice(0, 90) : String(err)}`;
  } finally {
    clearTimeout(t);
  }
}

const results = await Promise.all(models.map(async (m) => [m, await probe(m)] as const));
for (const [m, out] of results) console.log(`${out ? "UP  " : "DOWN"} ${m.padEnd(42)} ${out}`);
const up = results.filter(([, o]) => o.startsWith("HTTP 200"));
console.log(`\n[probe] ${up.length}/${results.length} reachable`);
process.exit(up.length > 0 ? 0 : 1);