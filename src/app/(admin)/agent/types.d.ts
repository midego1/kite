import type {
	AgentModelOption,
	AgentProviderConnection,
	AgentModelRates,
	AgentProviderKind,
	AgentProviderPreset,
	AgentProviderPublicConfig,
} from "@/lib/agent/provider-types";

export type AgentAdminConfig = AgentProviderPublicConfig;
export type AgentAdminSettingsResponse = {
	config: AgentAdminConfig;
	/** Saved providers, the one in use marked active; empty before migration 0077 and until the first save. */
	providers: AgentProviderConnection[];
	/** False before migration 0077: only the one provider in use can be saved. */
	providersReady: boolean;
	assistantEnabled: boolean;
	cloudflareAvailable: boolean;
	error?: string;
};
export type AgentEnabledResponse = { assistantEnabled: boolean; error?: string };
export type AgentAdminModelsResponse = { models: AgentModelOption[]; source: "catalog" | "suggested"; error?: string };
export type AgentAdminForm = {
	name: string;
	provider: AgentProviderKind;
	preset: AgentProviderPreset;
	baseUrl: string;
	apiKey: string;
	model: string;
	rates: Record<string, AgentModelRates>;
};
export type AgentModelLoadState = {
	key: string;
	loading: boolean;
	models: AgentModelOption[];
	source: AgentAdminModelsResponse["source"] | null;
	error: string | null;
};

/** What the provider form edits: the provider in use (before 0077 or while none is saved), a saved one, or a new one. */
export type AgentProviderEditTarget = { kind: "active" } | { kind: "saved"; id: string } | { kind: "new" };
