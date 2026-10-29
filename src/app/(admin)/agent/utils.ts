import { authFetch } from "@/lib/auth/client";
import { DEFAULT_CLOUDFLARE_MODEL, PROVIDER_BASE_URLS } from "@/lib/agent/provider-constants";
import type { AgentProviderPreset } from "@/lib/agent/provider-types";
import type { AgentProviderConnection } from "@/lib/agent/provider-types";
import type {
	AgentAdminForm,
	AgentAdminModelsResponse,
	AgentAdminSettingsResponse,
	AgentEnabledResponse,
	AgentProviderEditTarget,
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

/** Whose saved key a blank key field stands for when loading models: none for a new provider. */
function savedKeyProviderId(target: AgentProviderEditTarget): string | null | undefined {
	return target.kind === "saved" ? target.id : target.kind === "new" ? null : undefined;
}

export async function loadAgentModels(
	form: AgentAdminForm,
	target: AgentProviderEditTarget,
	signal?: AbortSignal,
): Promise<AgentAdminModelsResponse> {
	const response = await authFetch("/api/admin/agent/models", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			provider: form.provider,
			preset: form.preset,
			baseUrl: form.baseUrl,
			apiKey: form.apiKey,
			providerId: savedKeyProviderId(target),
		}),
		signal,
	});
	const data = (await response.json()) as AgentAdminModelsResponse;
	if (!response.ok) throw new Error(data.error || "Could not load models");
	return data;
}

async function agentAdminRequest(
	path: string,
	init: RequestInit,
	fallback: string,
): Promise<AgentAdminSettingsResponse> {
	const response = await authFetch(path, { ...init, headers: { "Content-Type": "application/json" } });
	const data = (await response.json()) as AgentAdminSettingsResponse;
	if (!response.ok) throw new Error(data.error || fallback);
	return data;
}

/**
 * Saves the form where it belongs: a new provider (used at once only when `activate` is set or it is the first),
 * an edited saved provider, or the provider in use.
 */
export function saveAgentProvider(
	target: AgentProviderEditTarget,
	form: AgentAdminForm,
	activate = false,
): Promise<AgentAdminSettingsResponse> {
	const fallback = "Could not save agent settings";
	if (target.kind === "new")
		return agentAdminRequest(
			"/api/admin/agent/providers",
			{ method: "POST", body: JSON.stringify({ ...form, activate }) },
			fallback,
		);
	if (target.kind === "saved")
		return agentAdminRequest(
			`/api/admin/agent/providers/${encodeURIComponent(target.id)}`,
			{ method: "PUT", body: JSON.stringify(form) },
			fallback,
		);
	const { name: _name, ...legacy } = form;
	return agentAdminRequest("/api/admin/agent", { method: "PUT", body: JSON.stringify(legacy) }, fallback);
}

export function activateAgentProvider(id: string): Promise<AgentAdminSettingsResponse> {
	return agentAdminRequest(
		`/api/admin/agent/providers/${encodeURIComponent(id)}/activate`,
		{ method: "POST" },
		"Could not switch providers",
	);
}

export function deleteAgentProvider(id: string): Promise<AgentAdminSettingsResponse> {
	return agentAdminRequest(
		`/api/admin/agent/providers/${encodeURIComponent(id)}`,
		{ method: "DELETE" },
		"Could not delete the provider",
	);
}

const EMPTY_FORM: AgentAdminForm = {
	name: "",
	provider: "cloudflare",
	preset: "openai",
	baseUrl: "",
	apiKey: "",
	model: DEFAULT_CLOUDFLARE_MODEL,
	rates: {},
};

/** The form for a saved provider, the provider in use, or a new provider (Haimaker first, as in the list). */
export function agentProviderForm(source: Omit<AgentProviderConnection, "id" | "active"> | null): AgentAdminForm {
	if (!source) return selectAgentProvider({ ...EMPTY_FORM }, "haimaker");
	return {
		name: source.name,
		provider: source.provider,
		preset: source.preset,
		baseUrl: source.baseUrl,
		apiKey: "",
		model: source.models.join(", "),
		rates: source.rates,
	};
}

/** The target the editor opens on: the provider in use when it is saved, else the single legacy form. */
export function initialEditTarget(data: Pick<AgentAdminSettingsResponse, "providers">): AgentProviderEditTarget {
	const active = data.providers.find((provider) => provider.active);
	return active ? { kind: "saved", id: active.id } : { kind: "active" };
}

/** One line under a saved provider's name: what it is, its default model and whether a key is stored. */
export function agentProviderSummary(provider: AgentProviderConnection): string {
	const kind =
		provider.provider === "cloudflare"
			? "Cloudflare Workers AI"
			: (PROVIDER_PRESETS.find((item) => item.id === provider.preset)?.label ?? "Custom endpoint");
	const parts = [kind, provider.model || "no model"];
	if (provider.preset === "custom" && provider.provider === "compatible") parts.push(provider.baseUrl);
	if (provider.provider === "compatible")
		parts.push(provider.keyUnreadable ? "key unreadable, enter it again" : provider.hasApiKey ? "key saved" : "no key");
	return parts.join(" · ");
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

/** Why the form cannot be saved yet: no model, Workers AI without its binding, or a provider without URL or key. */
export function agentProviderFormBlocked(
	form: AgentAdminForm,
	state: { selectedModelIds: string[]; cloudflareAvailable: boolean; canUseSavedKey: boolean },
): boolean {
	if (!state.selectedModelIds.length) return true;
	if (form.provider === "cloudflare") return !state.cloudflareAvailable;
	return !form.baseUrl || (!form.apiKey.trim() && !state.canUseSavedKey);
}

/** "Add provider" is the list's button, so a new provider is saved with the same label as an edited one. */
export function agentProviderSubmitLabel(target: AgentProviderEditTarget, providersReady: boolean): string {
	return target.kind === "new" || providersReady ? "Save provider" : "Save agent settings";
}

/** What saving said: for a new provider, whether the server put it in use (its `active` flag), not what was asked. */
export function agentProviderSavedMessage(target: AgentProviderEditTarget, addedActive: boolean): string {
	if (target.kind !== "new") return "Agent provider saved. Assistant settings can now choose from these models.";
	return addedActive ? "Provider added and in use." : "Provider added. Choose Use this provider to switch to it.";
}

/**
 * The confirmation a switch needs, or null: switching to another external vendor while external providers may read
 * mail moves that permission to the new vendor.
 */
export function switchConfirmation(
	data: Pick<AgentAdminSettingsResponse, "config" | "externalAutoReadAllowed">,
	provider: AgentProviderConnection,
): { title: string; description: string } | null {
	if (provider.provider !== "compatible" || !data.externalAutoReadAllowed) return null;
	const { config } = data;
	if (config.provider === "compatible" && config.preset === provider.preset && config.baseUrl === provider.baseUrl)
		return null;
	const vendor = provider.preset === "custom" ? provider.baseUrl : agentProviderSummary(provider).split(" · ")[0];
	return {
		title: `Switch to ${provider.name}?`,
		description: `External AI providers are allowed to read mail for automatic reading, Write with Kite and summaries. That permission will apply to ${provider.name} (${vendor}) from now on, and message content will be sent there.`,
	};
}
