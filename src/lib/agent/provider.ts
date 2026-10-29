import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { appSettings } from "@/db/schema";
import { readSavedAgentProvider, readStoredAgentProvider } from "./provider-connections";
import type { StoredAgentProvider } from "./provider-connection-utils";
import type { AgentProviderConfig, AgentProviderPreset, AgentProviderPublicConfig } from "./provider-types";
import { AGENT_SETTINGS_ID, DEFAULT_CLOUDFLARE_MODEL, PROVIDER_BASE_URLS } from "./provider-constants";
import { parseAgentModelIds } from "./model-ids";
import { parseAgentModelRates } from "./pricing";
import { resolveAgentModelRates, routesVendorModelIds } from "./model-prices-utils";
import { isAgentLoopbackAllowed, parseCustomAgentBaseUrl } from "./provider-url-utils";

export function resolveAgentBaseUrl(
	preset: AgentProviderPreset,
	customUrl: string,
	env?: Pick<CloudflareEnv, "AI_ALLOW_INSECURE_LOOPBACK">,
) {
	if (preset !== "custom") return PROVIDER_BASE_URLS[preset];
	const allowLoopback = isAgentLoopbackAllowed(env?.AI_ALLOW_INSECURE_LOOPBACK, process.env.NODE_ENV);
	return parseCustomAgentBaseUrl(customUrl, allowLoopback);
}

export async function getAgentEnabled(env: CloudflareEnv): Promise<boolean> {
	const [saved] = await getDb(env)
		.select({ enabled: appSettings.agentEnabled })
		.from(appSettings)
		.where(eq(appSettings.id, AGENT_SETTINGS_ID))
		.limit(1);
	return saved?.enabled ?? true;
}

export async function getAgentProviderConfig(env: CloudflareEnv): Promise<AgentProviderConfig> {
	const config = await readAgentProviderConfig(env);
	const vendorPrefixed = routesVendorModelIds(config.provider === "cloudflare" ? "cloudflare" : config.preset);
	return {
		...config,
		effectiveRates: resolveAgentModelRates(config.rates, config.models, undefined, undefined, { vendorPrefixed }),
	};
}

async function readAgentProviderConfig(env: CloudflareEnv): Promise<Omit<AgentProviderConfig, "effectiveRates">> {
	return resolveStoredAgentProvider(env, await readStoredAgentProvider(env));
}

/** Which provider a form edits: the one in use, a saved one, or a new one that has nothing stored yet. */
export type AgentProviderTarget = "active" | "new" | { id: string };

/**
 * The provider a form edits as requests would use it (an env key included), so a blank key field can keep its
 * stored key; null for a new provider, a missing one or one whose stored URL no longer resolves.
 */
export async function getTargetAgentProviderConfig(
	env: CloudflareEnv,
	target: AgentProviderTarget,
): Promise<Omit<AgentProviderConfig, "effectiveRates"> | null> {
	if (target === "new") return null;
	if (target === "active") return readAgentProviderConfig(env);
	const saved = await readSavedAgentProvider(env, target.id).catch(() => null);
	if (!saved) return null;
	try {
		return resolveStoredAgentProvider(env, saved);
	} catch {
		return null;
	}
}

/** The provider a stored row (saved, or the legacy columns) describes, with its key already opened. */
function resolveStoredAgentProvider(
	env: CloudflareEnv,
	saved: StoredAgentProvider | null,
): Omit<AgentProviderConfig, "effectiveRates"> {
	const rates = parseAgentModelRates(saved?.rates ?? null);
	if (saved?.provider === "cloudflare") {
		const models = parseAgentModelIds(saved.model || env.AI_MODEL || DEFAULT_CLOUDFLARE_MODEL);
		return {
			provider: "cloudflare",
			preset: "openai",
			baseUrl: "",
			apiKey: "",
			model: models[0] || DEFAULT_CLOUDFLARE_MODEL,
			models,
			rates,
			source: "saved",
		};
	}
	if (saved?.provider === "compatible") {
		const preset = saved.preset || "custom";
		const baseUrl = resolveAgentBaseUrl(preset, saved.baseUrl || "", env);
		const models = parseAgentModelIds(saved.model || "");
		return {
			provider: "compatible",
			preset,
			baseUrl,
			// An unreadable key never falls back to the environment's: requests fail and say why instead.
			apiKey: saved.keyUnreadable ? "" : saved.apiKey || (env.AI_BASE_URL === baseUrl ? env.AI_API_KEY : "") || "",
			model: models[0] || "",
			models,
			rates,
			source: "saved",
			...(saved.keyUnreadable ? { keyUnreadable: true } : {}),
		};
	}
	return unsavedAgentProviderConfig(env, rates);
}

/** The provider when none is saved: the Workers AI binding, else the `AI_BASE_URL` endpoint, else the default. */
function unsavedAgentProviderConfig(
	env: CloudflareEnv,
	rates: AgentProviderConfig["rates"],
): Omit<AgentProviderConfig, "effectiveRates"> {
	if (env.AI) {
		const model = env.AI_MODEL || DEFAULT_CLOUDFLARE_MODEL;
		return {
			provider: "cloudflare",
			preset: "openai",
			baseUrl: "",
			apiKey: "",
			model,
			models: [model],
			rates,
			source: "environment",
		};
	}
	if (env.AI_BASE_URL && env.AI_API_KEY) {
		const model = env.AI_MODEL || "gpt-4o-mini";
		return {
			provider: "compatible",
			preset: "custom",
			baseUrl: env.AI_BASE_URL,
			apiKey: env.AI_API_KEY,
			model,
			models: [model],
			rates,
			source: "environment",
		};
	}
	return {
		provider: "cloudflare",
		preset: "openai",
		baseUrl: "",
		apiKey: "",
		model: DEFAULT_CLOUDFLARE_MODEL,
		models: [DEFAULT_CLOUDFLARE_MODEL],
		rates,
		source: "default",
	};
}

export async function getAgentProviderPublicConfig(env: CloudflareEnv): Promise<AgentProviderPublicConfig> {
	const { apiKey, effectiveRates: _effectiveRates, ...config } = await getAgentProviderConfig(env);
	return {
		...config,
		hasApiKey: !!apiKey,
		configured:
			config.provider === "cloudflare"
				? !!env.AI && config.models.length > 0
				: !!apiKey && !!config.baseUrl && config.models.length > 0,
	};
}
