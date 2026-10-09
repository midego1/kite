import type { ActiveAlert, AlertRuleId } from "./alerts-types";
import { RULE_LABELS, RULE_ORDER } from "./rules-utils";

export type ActiveAlertView = { rule: AlertRuleId; name: string; count: number; href: string };

export function toActiveAlertView(active: ActiveAlert[]): ActiveAlertView[] {
	return [...active]
		.sort((a, b) => RULE_ORDER.indexOf(a.rule) - RULE_ORDER.indexOf(b.rule))
		.map((alert) => ({
			rule: alert.rule,
			name: RULE_LABELS[alert.rule].name,
			count: alert.count,
			href: RULE_LABELS[alert.rule].path,
		}));
}

/** Counts are left out so a dismissal holds until a rule or its fingerprint changes. */
export function alertSetSignature(active: ActiveAlert[]): string | null {
	if (active.length === 0) return null;
	return active
		.map((alert) => `${alert.rule}:${alert.fingerprint}`)
		.sort()
		.join("|");
}
