import { authFetch } from "@/lib/auth/client";
import { modelTrainsOnData } from "@/lib/agent/model-training-utils";
import { PROVIDER_BASE_URLS } from "@/lib/agent/provider-constants";
import type { AgentModelOption, AgentProviderPreset } from "@/lib/agent/provider-types";
import type {
	AgentAdminForm,
	AgentAdminModelsResponse,
	AgentAdminSettingsResponse,
	AgentEnabledResponse,
} from "./types";

export const PROVIDER_PRESETS: { id: AgentProviderPreset; label: string }[] = [
	{ id: "openai", label: "OpenAI" },
	{ id: "openrouter", label: "OpenRouter" },
	{ id: "groq", label: "Groq" },
	{ id: "meta", label: "Meta (Muse Spark)" },
	{ id: "custom", label: "Custom endpoint" },
];

export function baseUrlForPreset(preset: AgentProviderPreset, current = "") {
	return preset === "custom" ? current : PROVIDER_BASE_URLS[preset];
}

/** The message that stops the model list from loading, or null when the picker can load models. */
export function modelListError(form: AgentAdminForm, canUseSavedKey: boolean): string | null {
	// The Meta preset lists its own models, so its picker works before an API key is entered.
	const listsOwnModels = form.provider === "compatible" && form.preset === "meta";
	if (form.provider !== "compatible") return null;
	if (!form.baseUrl)
		return form.preset === "custom" ? "Enter an HTTPS base URL to load models." : "Enter an API key to load models.";
	if (!form.apiKey.trim() && !canUseSavedKey && !listsOwnModels) return "Enter an API key to load models.";
	return null;
}

/**
 * A selected model that may train on prompts and that the loaded list does not show, so its warning belongs
 * under the model IDs input: a listed model already shows the warning next to itself.
 */
export function typedTrainingModel(selectedModelIds: string[], models: AgentModelOption[]): boolean {
	return selectedModelIds.some((model) => modelTrainsOnData(model) && !models.some((item) => item.id === model));
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
