import type { CfEmailRoutingRule } from "@/lib/cloudflare-api.types";
import { renameRouteForWorker } from "@/lib/cloudflare-api-utils";

export function routesToWorker(rule: CfEmailRoutingRule, names: readonly string[]): boolean {
	return !!rule.actions?.some(
		(action) => action.type === "worker" && !!action.value?.some((value) => names.includes(value)),
	);
}

export function ruleAddress(rule: CfEmailRoutingRule): string {
	if (rule.matchers?.some((matcher) => matcher.type === "all")) return "*";
	return rule.matchers?.find((matcher) => matcher.type === "literal" && matcher.field === "to")?.value ?? "";
}

/**
 * The same rule with every Worker action sent to `workerName` instead of a
 * legacy Worker. Matchers, order and state are kept, and a name generated as
 * "Route ... to <old worker>" is updated so the dashboard reads correctly.
 */
export function repointRule(
	rule: CfEmailRoutingRule,
	workerName: string,
	legacyNames: readonly string[],
): CfEmailRoutingRule {
	const actions = (rule.actions ?? []).map((action) =>
		action.type === "worker" && action.value?.some((value) => legacyNames.includes(value))
			? { type: "worker" as const, value: [workerName] }
			: action,
	);
	const name = renameRouteForWorker(rule.name, workerName, legacyNames);
	return {
		actions,
		enabled: rule.enabled ?? true,
		matchers: rule.matchers,
		...(name ? { name } : {}),
		...(rule.priority === undefined ? {} : { priority: rule.priority }),
	};
}
