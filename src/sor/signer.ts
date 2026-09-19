// SOR signing helpers — canonical JSON + HMAC-SHA256 hash chaining.
// Pure functions; self-contained (ported from Fleet's signer, no import).

import { createHmac } from "node:crypto";
import { eventToRecord, type SorEvent } from "./events.ts";

/** Fixed genesis hash — the start of every chain (hex of "self-healer-sor-genesis"). */
export const GENESIS_HASH =
	"73656c662d6865616c65722d736f722d67656e65736973";

function canonicalize(v: unknown): unknown {
	if (Array.isArray(v)) {
		return v.map((el) => canonicalize(el)).filter((el) => el !== undefined);
	}
	if (v !== null && typeof v === "object") {
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(v as Record<string, unknown>).sort()) {
			const val = canonicalize((v as Record<string, unknown>)[key]);
			if (val !== undefined) out[key] = val;
		}
		return out;
	}
	if (typeof v === "number") {
		if (Number.isNaN(v)) return undefined;
		return String(v);
	}
	if (v === undefined || typeof v === "function" || typeof v === "symbol") {
		return undefined; // dropped
	}
	return v;
}

/** Deterministic canonical serialization: deep-sorted keys, stable stringify,
 *  numbers via String(), undefined/NaN dropped. */
export function canonicalJson(obj: unknown): string {
	const s = JSON.stringify(canonicalize(obj));
	return s === undefined ? "" : s;
}

/** HMAC-SHA256 hex over `prevHash + '||' + canonical` using `key` as the secret. */
export function computeHash(
	key: string,
	prevHash: string,
	canonical: string,
): string {
	return createHmac("sha256", key)
		.update(`${prevHash}||${canonical}`)
		.digest("hex");
}

/** Canonicalize the event record (columns only) and hash it onto prevHash.
 *  If keyId is provided it is included in the canonical record as a field. */
export function signEvent(
	key: string,
	prevHash: string,
	event: SorEvent,
	keyId?: string,
): string {
	const record = { ...eventToRecord(event) };
	if (keyId !== undefined) {
		record.key_id = keyId;
	}
	return computeHash(key, prevHash, canonicalJson(record));
}