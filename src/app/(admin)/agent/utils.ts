import { authFetch } from "@/lib/auth/client";
import { DEFAULT_CLOUDFLARE_MODEL, PROVIDER_BASE_URLS } from "@/lib/agent/provider-constants";
import type { AgentProviderPreset } from "@/lib/agent/provider-types";
import type {
	AgentAdminForm,
	AgentAdminModelsResponse,
	AgentAdminSettingsResponse,
	AgentEnabledResponse,
} from "./types";

export const PROVIDER_PRESETS: { id: AgentProviderPreset; label: string }[] = [
	{ id: "haimaker", label: "Haimaker.ai" },
	{ id: "anthropic", label: "Anthropic" },
	{ id: "openai", label: "OpenAI" },
	{ id: "openrouter", label: "OpenRouter" },
	{ id: "groq", label: "Groq" },
	{ id: "custom", label: "Custom endpoint" },
];

function baseUrlForPreset(preset: AgentProviderPreset, current = "") {
	return preset === "custom" ? current : PROVIDER_BASE_URLS[preset];
}

export function selectAgentProvider(form: AgentAdminForm, value: string): AgentAdminForm {
	if (value === "cloudflare")
		return {
			...form,
			provider: "cloudflare",
			preset: "openai",
			baseUrl: "",
			apiKey: "",
			model: DEFAULT_CLOUDFLARE_MODEL,
		};
	const preset = value as AgentProviderPreset;
	return { ...form, provider: "compatible", preset, baseUrl: baseUrlForPreset(preset), apiKey: "", model: "" };
}

/** Why the model catalog cannot be loaded yet, or null when the provider settings are complete. */
export function agentModelInputError(form: AgentAdminForm, canUseSavedKey: boolean): string | null {
	if (form.provider !== "compatible") return null;
	if (form.baseUrl && (form.apiKey.trim() || canUseSavedKey)) return null;
	return form.preset === "custom" && !form.baseUrl
		? "Enter an HTTPS base URL to load models."
		: "Enter an API key to load models.";
}

export function updateAgentModelRate(
	form: AgentAdminForm,
	model: string,
	kind: "input" | "output",
	value: string,
): AgentAdminForm {
	const current = form.rates[model] ?? { input: null, output: null };
	return { ...form, rates: { ...form.rates, [model]: { ...current, [kind]: value === "" ? null : Number(value) } } };
}

export async function loadAgentAdminSettings(): Promise<AgentAdminSettingsResponse> {
	const response = await authFetch("/api/admin/agent");
	const data = (await response.json()) as AgentAdminSettingsResponse;
	if (!response.ok) throw new Error(data.error || "Could not load agent settings");
	return data;
}

export async function loadAgentModels(form: AgentAdminForm, signal?: AbortSignal): Promise<AgentAdminModelsResponse> {
	const response = await authFetch("/api/admin/agent/models", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(form),
		signal,
	});
	const data = (await response.json()) as AgentAdminModelsResponse;
	if (!response.ok) throw new Error(data.error || "Could not load models");
	return data;
}

export async function saveAgentAdminSettings(form: AgentAdminForm): Promise<AgentAdminSettingsResponse> {
	const response = await authFetch("/api/admin/agent", {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(form),
	});
	const data = (await response.json()) as AgentAdminSettingsResponse;
	if (!response.ok) throw new Error(data.error || "Could not save agent settings");
	return data;
}

export async function saveAgentEnabled(enabled: boolean): Promise<AgentEnabledResponse> {
	const response = await authFetch("/api/admin/agent", {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ enabled }),
	});
	const data = (await response.json()) as AgentEnabledResponse;
	if (!response.ok) throw new Error(data.error || "Could not update assistant availability");
	return data;
}
