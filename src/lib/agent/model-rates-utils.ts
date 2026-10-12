import type { AgentModelRates } from "./provider-types";

/**
 * Applies catalog-published prices per model, so a field the catalog never publishes
 * (such as a saved reasoning effort) survives a model list refresh.
 */
export function mergePublishedAgentRates(
	current: Record<string, AgentModelRates>,
	published: Record<string, AgentModelRates>,
): Record<string, AgentModelRates> {
	const merged = { ...current };
	for (const [id, rates] of Object.entries(published)) merged[id] = { ...current[id], ...rates };
	return merged;
}
