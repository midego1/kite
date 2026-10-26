import type { RelaySignatureState } from "./alerts-types";

const RELAY_SIGNATURE_KEY = "system/relay-signature.json";
const RECORD_INTERVAL_MS = 10 * 60_000;
const recordedAt = new Map<"missing" | "invalid", number>();

export async function readRelaySignatureState(env: CloudflareEnv): Promise<RelaySignatureState> {
	const object = await env.BUCKET.get(RELAY_SIGNATURE_KEY);
	if (!object) return {};
	try {
		const parsed = JSON.parse(await object.text()) as RelaySignatureState;
		return {
			...(typeof parsed.missingAt === "number" ? { missingAt: parsed.missingAt } : {}),
			...(typeof parsed.invalidAt === "number" ? { invalidAt: parsed.invalidAt } : {}),
		};
	} catch {
		return {};
	}
}

/**
 * Notes that a relay request came without a valid headers signature, for the `relay_signature` alert.
 * Written at most every ten minutes per kind and isolate; a failure is only logged by the caller.
 */
export async function recordRelaySignatureProblem(
	env: CloudflareEnv,
	kind: "missing" | "invalid",
	now = Date.now(),
): Promise<void> {
	if (now - (recordedAt.get(kind) ?? -Infinity) < RECORD_INTERVAL_MS) return;
	recordedAt.set(kind, now);
	const state = await readRelaySignatureState(env);
	await env.BUCKET.put(RELAY_SIGNATURE_KEY, JSON.stringify({ ...state, [`${kind}At`]: now }), {
		httpMetadata: { contentType: "application/json" },
	});
}
