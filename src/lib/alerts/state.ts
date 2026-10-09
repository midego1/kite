import type { AlertState } from "./alerts-types";

const ALERT_STATE_KEY = "system/alert-state.json";

export async function readAlertState(env: CloudflareEnv): Promise<AlertState | null> {
	const object = await env.BUCKET.get(ALERT_STATE_KEY);
	if (!object) return null;
	try {
		const parsed = JSON.parse(await object.text()) as Partial<AlertState>;
		if (parsed.version !== 1 || typeof parsed.initializedAt !== "number") return null;
		return { ...parsed, version: 1, initializedAt: parsed.initializedAt, rules: parsed.rules ?? {} };
	} catch {
		return null;
	}
}

export async function writeAlertState(env: CloudflareEnv, state: AlertState): Promise<void> {
	await env.BUCKET.put(ALERT_STATE_KEY, JSON.stringify(state), {
		httpMetadata: { contentType: "application/json" },
	});
}
