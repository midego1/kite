import type {
	AgentModelOption,
	AgentModelRates,
	AgentProviderKind,
	AgentProviderPreset,
	AgentProviderPublicConfig,
} from "@/lib/agent/provider-types";

export type AgentAdminConfig = AgentProviderPublicConfig;
export type AgentAdminSettingsResponse = {
	config: AgentAdminConfig;
	assistantEnabled: boolean;
	cloudflareAvailable: boolean;
	error?: string;
};
export type AgentEnabledResponse = { assistantEnabled: boolean; error?: string };
export type AgentAdminModelsResponse = { models: AgentModelOption[]; source: "catalog" | "suggested"; error?: string };
export type AgentAdminForm = {
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
