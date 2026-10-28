import type {
	AgentModelRates,
	AgentProviderConnection,
	AgentProviderKind,
	AgentProviderPreset,
} from "./provider-types";
import { parseAgentModelIds } from "./model-ids";
import { parseAgentModelRates } from "./pricing";

/** One stored provider: a row of `agent_providers` or the legacy `app_settings.agent_*` columns. */
export type StoredAgentProvider = {
	provider: AgentProviderKind | null;
	preset: AgentProviderPreset | null;
	baseUrl: string | null;
	apiKey: string | null;
	model: string | null;
	rates: string | null;
};

export type StoredAgentProviderRow = Omit<StoredAgentProvider, "provider" | "model"> & {
	id: string;
	name: string;
	provider: AgentProviderKind;
	model: string;
	active: boolean;
	createdAt: Date;
};

const PROVIDER_PRESET_LABELS: Record<AgentProviderPreset, string> = {
	haimaker: "Haimaker.ai",
	anthropic: "Anthropic",
	openai: "OpenAI",
	openrouter: "OpenRouter",
	groq: "Groq",
	custom: "Custom endpoint",
};

const CLOUDFLARE_PROVIDER_LABEL = "Cloudflare Workers AI";
export const MAX_PROVIDER_NAME_LENGTH = 80;

/** The name a provider gets when none is typed, also used by migration 0077 for the copied provider. */
export function defaultAgentProviderName(provider: AgentProviderKind, preset: AgentProviderPreset | null): string {
	return provider === "cloudflare" ? CLOUDFLARE_PROVIDER_LABEL : PROVIDER_PRESET_LABELS[preset ?? "custom"];
}

/** A typed name trimmed and capped, or the provider's default name when blank. */
export function agentProviderName(
	name: string | undefined,
	provider: AgentProviderKind,
	preset: AgentProviderPreset | null,
): string {
	const trimmed = name?.trim().slice(0, MAX_PROVIDER_NAME_LENGTH);
	return trimmed || defaultAgentProviderName(provider, preset);
}

/** What the admin page lists for a saved provider: never the key, only whether one is stored. */
export function publicAgentProvider(row: StoredAgentProviderRow): AgentProviderConnection {
	const models = parseAgentModelIds(row.model);
	return {
		id: row.id,
		name: row.name,
		provider: row.provider,
		preset: row.provider === "compatible" ? (row.preset ?? "custom") : "openai",
		baseUrl: row.provider === "compatible" ? (row.baseUrl ?? "") : "",
		model: models[0] ?? "",
		models,
		rates: parseAgentModelRates(row.rates),
		hasApiKey: !!row.apiKey,
		active: row.active,
	};
}

/** Saved providers in the order they were added, the active one marked. */
export function sortAgentProviders<T extends { createdAt: Date; id: string }>(rows: T[]): T[] {
	return [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
}

/** The saved model rates of `modelIds` only, in the shape `agent_model_rates` stores. */
export function savedAgentModelRates(
	modelIds: string[],
	rates: Record<
		string,
		{ input?: number | null; output?: number | null; reasoningEffort?: AgentModelRates["reasoningEffort"] | null }
	> = {},
): string {
	return JSON.stringify(
		Object.fromEntries(
			modelIds.map((model) => {
				const { input = null, output = null, reasoningEffort } = rates[model] ?? {};
				return [model, reasoningEffort ? { input, output, reasoningEffort } : { input, output }];
			}),
		),
	);
}

/**
 * A model choice saved for a mailbox that the active provider does not offer: what is used instead (the provider's
 * default, or null for the triage model, which then follows the chat model), so the settings can say so.
 */
export function unavailableModelChoice(
	saved: string | null | undefined,
	models: string[],
	fallback: string | null,
): { saved: string; using: string | null } | null {
	return saved && !models.includes(saved) ? { saved, using: fallback } : null;
}
