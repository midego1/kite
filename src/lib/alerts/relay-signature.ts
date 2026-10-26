import type { RelaySignatureState } from "./alerts-types";

/** `legacy`: the earlier header signature form, still accepted until it is removed (issue #118). */
type RelaySignatureProblem = "missing" | "invalid" | "legacy";

const KINDS = ["missing", "invalid", "legacy"] as const;
const RECORD_INTERVAL_MS = 10 * 60_000;
const recordedAt = new Map<RelaySignatureProblem, number>();
const saving = new Set<RelaySignatureProblem>();

/** One object per kind, so requests of different kinds never overwrite each other's time. */
const keyOf = (kind: RelaySignatureProblem) => `system/relay-signature-${kind}.json`;

async function readAt(env: CloudflareEnv, kind: RelaySignatureProblem): Promise<number | undefined> {
	try {
		const object = await env.BUCKET.get(keyOf(kind));
		if (!object) return undefined;
		const at = (JSON.parse(await object.text()) as { at?: unknown }).at;
		return typeof at === "number" ? at : undefined;
	} catch {
		return undefined;
	}
}

export async function readRelaySignatureState(env: CloudflareEnv): Promise<RelaySignatureState> {
	const times = await Promise.all(KINDS.map((kind) => readAt(env, kind)));
	const state: RelaySignatureState = {};
	KINDS.forEach((kind, index) => {
		const at = times[index];
		if (at !== undefined) state[`${kind}At`] = at;
	});
	return state;
}

/**
 * Notes that a relay request came without a valid headers signature (`relay_signature` alert) or with
 * the legacy form (`relay_signature_legacy`). Written at most every ten minutes per kind and isolate,
 * counted from the last write that succeeded, so a failed write is retried by the next request; a
 * failure is only logged by the caller.
 */
export async function recordRelaySignatureProblem(
	env: CloudflareEnv,
	kind: RelaySignatureProblem,
	now = Date.now(),
): Promise<void> {
	if (saving.has(kind) || now - (recordedAt.get(kind) ?? -Infinity) < RECORD_INTERVAL_MS) return;
	saving.add(kind);
	try {
		await env.BUCKET.put(keyOf(kind), JSON.stringify({ at: now }), {
			httpMetadata: { contentType: "application/json" },
		});
		recordedAt.set(kind, now);
	} finally {
		saving.delete(kind);
	}
}
