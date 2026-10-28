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
	/** The stored key is sealed under another APP_ENCRYPTION_KEY and could not be opened; `apiKey` is then null. */
	keyUnreadable?: boolean;
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

/**
 * Whether a compatible provider without a stored key uses `AI_API_KEY`: its base URL is `AI_BASE_URL`. That key is
 * read from the environment on every request and never copied into the database.
 */
export function environmentKeyApplies(
	env: Pick<CloudflareEnv, "AI_BASE_URL" | "AI_API_KEY">,
	row: Pick<StoredAgentProvider, "provider" | "baseUrl" | "apiKey">,
): boolean {
	return (
		row.provider === "compatible" && !row.apiKey && !!env.AI_API_KEY && !!row.baseUrl && env.AI_BASE_URL === row.baseUrl
	);
}

/** What the admin page lists for a saved provider: never the key, only whether one is stored and readable. */
export function publicAgentProvider(
	row: StoredAgentProviderRow,
	key: { keyUnreadable?: boolean; environmentKey?: boolean } = {},
): AgentProviderConnection {
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
		hasApiKey: key.keyUnreadable ? false : !!row.apiKey || !!key.environmentKey,
		keyUnreadable: !!key.keyUnreadable,
		active: row.active,
	};
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
