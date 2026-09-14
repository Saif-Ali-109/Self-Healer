import { createHmac, timingSafeEqual } from "node:crypto";
import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import { loadConfig } from "../config.ts";
import { getPool } from "../db/pool.ts";
import { CiQueue } from "../pipeline/queue.ts";
import { mapGitHubActions } from "./adapters/github.ts";
import { validateCiEvent } from "./normalize.ts";

const MAX_BODY_BYTES = 256 * 1024;

/** Timing-safe HMAC-SHA256 verification. */
function verifyWebhookSecret(
	rawBody: string,
	header: string | undefined,
	secret: string,
): boolean {
	if (!header) return false;
	const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
	const a = Buffer.from(expected);
	const b = Buffer.from(header);
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}

/**
 * Core CI webhook handler. Callable from the standalone server
 * or mountable via Fleet's WebhookHandler interface.
 */
export async function handleCiWebhook(
	headers: Record<string, string | string[] | undefined>,
	rawBody: string,
): Promise<{ status: number; body?: unknown }> {
	const config = loadConfig();
	const secretHeader = Array.isArray(headers["x-webhook-secret"])
		? headers["x-webhook-secret"][0]
		: (headers["x-webhook-secret"] as string | undefined);

	if (!verifyWebhookSecret(rawBody, secretHeader, config.webhookSecret))
		return { status: 401, body: { error: "invalid webhook secret" } };

	let parsed: unknown;
	try {
		parsed = JSON.parse(rawBody);
	} catch {
		return { status: 400, body: { error: "invalid JSON" } };
	}

	// Map via GitHub Actions adapter first
	const mapped = mapGitHubActions(parsed, headers);
	if ("error" in mapped) return { status: 400, body: { error: mapped.error } };

	// Validate canonical shape
	const validated = validateCiEvent(mapped);
	if ("error" in validated)
		return { status: 400, body: { error: validated.error } };

	// Enqueue (dedupe via unique index)
	const pool = getPool();
	const queue = new CiQueue(pool);
	const result = await queue.enqueue(validated);

	if (result.duplicate)
		return { status: 409, body: { error: "duplicate event already enqueued" } };

	return { status: 202, body: { ok: true, run_id: result.run_id } };
}

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let bytes = 0;
		req.on("data", (c: Buffer) => {
			bytes += c.length;
			if (bytes > MAX_BODY_BYTES) {
				req.destroy();
				reject(new Error("body too large"));
				return;
			}
			chunks.push(c);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-cache",
	});
	res.end(JSON.stringify(body));
}

/**
 * Start the standalone webhook server.
 * POST /api/webhook/ci → verify → map → validate → enqueue → 202/400/401/409
 */
export async function startWebhookServer(
	port: number = Number(process.env.CI_WEBHOOK_PORT) || 3457,
): Promise<Server> {
	const server = createServer(
		async (req: IncomingMessage, res: ServerResponse) => {
			if (
				req.method === "POST" &&
				(req.url ?? "").startsWith("/api/webhook/ci")
			) {
				try {
					const rawBody = await readBody(req);
					const result = await handleCiWebhook(
						req.headers as Record<string, string | string[] | undefined>,
						rawBody,
					);
					sendJson(res, result.status, result.body ?? { ok: true });
				} catch (err) {
					sendJson(res, 500, {
						error: String(err instanceof Error ? err.message : err),
					});
				}
			} else {
				sendJson(res, 404, { error: "not found" });
			}
		},
	);

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, "0.0.0.0", () => {
			server.removeListener("error", reject);
			resolve();
		});
	});

	console.log(
		`▶ CI webhook listening on http://0.0.0.0:${port}/api/webhook/ci`,
	);
	return server;
}
