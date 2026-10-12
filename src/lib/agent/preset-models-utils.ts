import type { AgentModelOption, AgentProviderPreset } from "./provider-types";
import { META_AGENT_MODELS } from "./provider-constants";

/** Models a preset lists on its own, so its picker is usable before (or without) a live catalog. */
export function presetAgentModels(preset: AgentProviderPreset): AgentModelOption[] {
	return preset === "meta" ? META_AGENT_MODELS : [];
}

/**
 * Merges a preset's known models into its live catalog: a known model keeps its curated name, rates and
 * `trainsOnData` flag, and catalog models the preset does not know about are appended, sorted by name.
 */
export function mergePresetAgentModels(known: AgentModelOption[], catalog: AgentModelOption[]): AgentModelOption[] {
	if (!known.length) return catalog;
	const merged = new Map(known.map((model) => [model.id, model]));
	for (const model of catalog) if (!merged.has(model.id)) merged.set(model.id, model);
	return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
}
