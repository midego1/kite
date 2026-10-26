import type { RelaySignatureState } from "./alerts-types";

/** `legacy`: the earlier header signature form, still accepted until it is removed (issue #118). */
type RelaySignatureProblem = "missing" | "invalid" | "legacy";

const RELAY_SIGNATURE_KEY = "system/relay-signature.json";
const RECORD_INTERVAL_MS = 10 * 60_000;
const recordedAt = new Map<RelaySignatureProblem, number>();

export async function readRelaySignatureState(env: CloudflareEnv): Promise<RelaySignatureState> {
	const object = await env.BUCKET.get(RELAY_SIGNATURE_KEY);
	if (!object) return {};
	try {
		const parsed = JSON.parse(await object.text()) as RelaySignatureState;
		const state: RelaySignatureState = {};
		for (const kind of ["missing", "invalid", "legacy"] as const) {
			const at = parsed[`${kind}At`];
			if (typeof at === "number") state[`${kind}At`] = at;
		}
		return state;
	} catch {
		return {};
	}
}

/**
 * Notes that a relay request came without a valid headers signature (`relay_signature` alert) or with
 * the legacy form (`relay_signature_legacy`).
 * Written at most every ten minutes per kind and isolate; a failure is only logged by the caller.
 */
export async function recordRelaySignatureProblem(
	env: CloudflareEnv,
	kind: RelaySignatureProblem,
	now = Date.now(),
): Promise<void> {
	if (now - (recordedAt.get(kind) ?? -Infinity) < RECORD_INTERVAL_MS) return;
	recordedAt.set(kind, now);
	const state = await readRelaySignatureState(env);
	await env.BUCKET.put(RELAY_SIGNATURE_KEY, JSON.stringify({ ...state, [`${kind}At`]: now }), {
		httpMetadata: { contentType: "application/json" },
	});
}
