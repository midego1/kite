import type { AgentProviderPreset } from "./provider-types";

export const AGENT_SETTINGS_ID = "default";
export const DEFAULT_CLOUDFLARE_MODEL = "@cf/moonshotai/kimi-k2.5";
export const PROVIDER_BASE_URLS: Record<Exclude<AgentProviderPreset, "custom">, string> = {
	haimaker: "https://api.haimaker.ai/v1",
	anthropic: "https://api.anthropic.com/v1",
	openai: "https://api.openai.com/v1",
	openrouter: "https://openrouter.ai/api/v1",
	groq: "https://api.groq.com/openai/v1",
};
/** Audit actions of saved AI providers (Admin → Agent), listed on Activity. */
export const AGENT_PROVIDER_AUDIT_ACTIONS = [
	"agent.provider_added",
	"agent.provider_updated",
	"agent.provider_switched",
	"agent.provider_deleted",
] as const;
