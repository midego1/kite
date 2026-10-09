import { getEnv } from "@/lib/cloudflare";
import { requireSessionAdmin } from "@/lib/api/auth";
import { alertSetSignature, toActiveAlertView } from "@/lib/alerts/active-utils";
import { ALERT_POLICY, evaluateAlertRules } from "@/lib/alerts/rules-utils";
import { collectAlertSnapshot } from "@/lib/alerts/snapshot";
import { readAlertState } from "@/lib/alerts/state";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Read-only view of the alerts the cron would report right now. It never writes the
 * alert state (not even a baseline) and never notifies; without a baseline the
 * counting rules look back over the normal window only.
 */
export async function GET(request: Request) {
	const env = getEnv();
	const auth = await requireSessionAdmin(env, request);
	if (auth.error) {
		auth.error.headers.set("Cache-Control", "no-store");
		return auth.error;
	}
	if (env.OPERATIONAL_ALERTS === "off") {
		return Response.json({ enabled: false, alerts: [], signature: null }, { headers: NO_STORE });
	}
	const now = new Date();
	const state = await readAlertState(env);
	const snapshot = await collectAlertSnapshot(env, now, state?.initializedAt ?? 0, ALERT_POLICY);
	const active = evaluateAlertRules(snapshot, now, ALERT_POLICY);
	return Response.json(
		{ enabled: true, alerts: toActiveAlertView(active), signature: alertSetSignature(active) },
		{ headers: NO_STORE },
	);
}
