import { createLogger } from "../logger.mjs";
import type { AlertState } from "./alerts-types";
import { type AlertDeliveryOptions, deliverAlertChannels } from "./channels";
import { decideDeliveryOutcome } from "./delivery-utils";
import { ALERT_POLICY, decideNotifications, evaluateAlertRules } from "./rules-utils";
import { collectAlertSnapshot } from "./snapshot";
import { readAlertState, writeAlertState } from "./state";

const logger = createLogger("alerts");

/**
 * Evaluate the operational alert rules and notify the primary admin (email) and
 * the alert webhook about new or long-standing problems.
 */
export async function runOperationalAlerts(
	env: CloudflareEnv,
	now: Date,
	options: AlertDeliveryOptions = {},
): Promise<void> {
	if (env.OPERATIONAL_ALERTS === "off") return;

	const state = await readAlertState(env);
	if (!state) {
		await writeAlertState(env, { version: 1, initializedAt: now.getTime(), rules: {} });
		logger.info("alerts.baseline_recorded");
		return;
	}

	const snapshot = await collectAlertSnapshot(env, now, state.initializedAt, ALERT_POLICY);
	const active = evaluateAlertRules(snapshot, now, ALERT_POLICY);
	const { notify, nextState } = decideNotifications(active, state, now, ALERT_POLICY);

	if (notify.length === 0) {
		if (JSON.stringify(nextState) !== JSON.stringify(state)) await writeAlertState(env, nextState);
		return;
	}

	const rules = notify.map((alert) => alert.rule);
	const results = await deliverAlertChannels(env, notify, { now, ...options });
	const outcome = decideDeliveryOutcome(results);
	if (outcome === "skipped") {
		logger.warn("alerts.notify_skipped", { reason: "no_channel", rules, results });
		return;
	}
	if (outcome === "failed") {
		logger.error("alerts.notify_failed", { rules, results });
		const attempted: AlertState = { ...state, lastAttemptAt: now.getTime() };
		await writeAlertState(env, attempted).catch((writeError) =>
			logger.error("alerts.state_write_failed", { error: writeError }),
		);
		return;
	}
	await writeAlertState(env, nextState);
	const channels = results.filter((result) => result.outcome === "sent").map((result) => result.channel);
	logger.info("alerts.notified", { rules, count: notify.length, channels });
}
