import type { ActiveAlert, AlertPolicy, AlertRuleId, AlertSnapshot, AlertState } from "./alerts-types";

export const ALERT_POLICY: AlertPolicy = {
	outboundFailedThreshold: 5,
	windowMinutes: 60,
	stuckQueuedMinutes: 30,
	stuckSendingMinutes: 15,
	webhookExhaustedThreshold: 1,
	remindAfterHours: 24,
	minEmailIntervalMinutes: 60,
	sendBackoffMinutes: 60,
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const RULE_LABELS: Record<AlertRuleId, { name: string; path: string }> = {
	backup_failed: { name: "Failed backups", path: "/backups" },
	outbound_failed: { name: "Failed outbound sends in the last hour", path: "/admin" },
	outbound_stuck: { name: "Outbound messages stuck in the queue", path: "/admin" },
	webhook_exhausted: { name: "Webhook deliveries that ran out of retries", path: "/webhooks" },
};

export const RULE_ORDER: AlertRuleId[] = ["backup_failed", "outbound_failed", "outbound_stuck", "webhook_exhausted"];

/** Turn a snapshot into the alerts that are active right now. The fingerprint changes when a new problem joins an existing rule. */
export function evaluateAlertRules(
	snapshot: AlertSnapshot,
	_now: Date,
	policy: AlertPolicy = ALERT_POLICY,
): ActiveAlert[] {
	const alerts: ActiveAlert[] = [];
	if (snapshot.failedBackups.length > 0) {
		const ids = snapshot.failedBackups.map((backup) => backup.id).sort();
		alerts.push({ rule: "backup_failed", fingerprint: ids.join(","), count: ids.length });
	}
	if (snapshot.outboundFailed >= policy.outboundFailedThreshold) {
		alerts.push({ rule: "outbound_failed", fingerprint: "active", count: snapshot.outboundFailed });
	}
	if (snapshot.outboundStuck > 0) {
		alerts.push({ rule: "outbound_stuck", fingerprint: "active", count: snapshot.outboundStuck });
	}
	if (snapshot.webhookExhausted >= policy.webhookExhaustedThreshold) {
		alerts.push({
			rule: "webhook_exhausted",
			fingerprint: String(snapshot.webhookLastAttemptAt ?? "active"),
			count: snapshot.webhookExhausted,
		});
	}
	return alerts;
}

/**
 * Pick the alerts to email now and the state to keep. Rules that are no longer
 * active are dropped so a recurrence notifies again. The caller persists
 * `nextState` after a successful send, or straight away when nothing is sent.
 */
export function decideNotifications(
	active: ActiveAlert[],
	state: AlertState,
	now: Date,
	policy: AlertPolicy = ALERT_POLICY,
): { notify: ActiveAlert[]; nextState: AlertState } {
	const at = now.getTime();
	const kept: AlertState["rules"] = {};
	const due: ActiveAlert[] = [];
	for (const alert of active) {
		const previous = state.rules[alert.rule];
		if (previous) kept[alert.rule] = previous;
		const reminderDue = previous !== undefined && at - previous.notifiedAt >= policy.remindAfterHours * HOUR;
		if (!previous || previous.fingerprint !== alert.fingerprint || reminderDue) due.push(alert);
	}

	const emailAllowed =
		due.length > 0 &&
		(state.lastEmailAt === undefined || at - state.lastEmailAt >= policy.minEmailIntervalMinutes * MINUTE) &&
		(state.lastAttemptAt === undefined || at - state.lastAttemptAt >= policy.sendBackoffMinutes * MINUTE);
	if (!emailAllowed) return { notify: [], nextState: { ...state, rules: kept } };

	for (const alert of due) kept[alert.rule] = { fingerprint: alert.fingerprint, notifiedAt: at };
	const { lastAttemptAt: _cleared, ...rest } = state;
	return { notify: due, nextState: { ...rest, lastEmailAt: at, rules: kept } };
}

/** Rule names, counts and link paths only; no addresses, ids or error text. */
export function renderAlertEmail(
	alerts: ActiveAlert[],
	options: { appName: string; appUrl?: string },
): { subject: string; text: string } {
	const sorted = [...alerts].sort((a, b) => RULE_ORDER.indexOf(a.rule) - RULE_ORDER.indexOf(b.rule));
	const subject = `${options.appName}: ${sorted.length} operational alert${sorted.length === 1 ? "" : "s"}`;
	const base = options.appUrl?.trim().replace(/\/+$/, "");
	const lines = sorted.map((alert) => {
		const label = RULE_LABELS[alert.rule];
		return `- ${label.name}: ${alert.count}${base ? `\n  ${base}${label.path}` : ""}`;
	});
	const text = [
		`${options.appName} detected operational problems that need attention:`,
		"",
		...lines,
		"",
		"An unchanged problem is repeated after 24 hours. Set OPERATIONAL_ALERTS=off to turn these emails off.",
	].join("\n");
	return { subject, text };
}
