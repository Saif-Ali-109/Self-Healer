import { LlmError } from "./types.ts";

const sleep = (ms: number): Promise<void> =>
	new Promise((r) => setTimeout(r, ms));

export interface PostJsonOptions {
	url: string;
	headers: Record<string, string>;
	body: unknown;
	signal?: AbortSignal | undefined;
	timeoutMs?: number;
	retries?: number;
	/** Injected in tests. */
	fetchImpl?: typeof fetch;
}

/**
 * POST JSON with a timeout and bounded retries on 429/5xx/network errors.
 * Error messages never include request headers (which carry API keys).
 */
export async function postJson(opts: PostJsonOptions): Promise<unknown> {
	const doFetch = opts.fetchImpl ?? fetch;
	const retries = opts.retries ?? 8;
	let lastErr: LlmError | undefined;
	for (let attempt = 0; attempt <= retries; attempt++) {
		const timeout = AbortSignal.timeout(opts.timeoutMs ?? 180_000);
		const signal = opts.signal
			? AbortSignal.any([opts.signal, timeout])
			: timeout;
		try {
			const res = await doFetch(opts.url, {
				method: "POST",
				headers: { "content-type": "application/json", ...opts.headers },
				body: JSON.stringify(opts.body),
				signal,
			});
			const text = await res.text();
			if (res.ok) {
				try {
					return JSON.parse(text) as unknown;
				} catch {
					throw new LlmError("provider returned non-JSON body", {
						retryable: true,
					});
				}
			}
			const retryable = res.status === 429 || res.status >= 500;
			lastErr = new LlmError(
				`HTTP ${res.status}: ${text.slice(0, 500).replace(/\s+/g, " ")}`,
				{ retryable, status: res.status },
			);
			if (!retryable) throw lastErr;
		} catch (err) {
			if (err instanceof LlmError && !err.retryable) throw err;
			if (opts.signal?.aborted) throw new LlmError("aborted");
			lastErr =
				err instanceof LlmError
					? err
					: new LlmError(`network error: ${String(err)}`, { retryable: true });
		}
		if (attempt < retries) await sleep(2000 * 2 ** attempt);
	}
	throw lastErr ?? new LlmError("request failed");
}
