import { z } from "zod";
import { createAuditLog } from "@/lib/mailboxes/audit";
import { sealSetting } from "@/lib/security/secret-box";
import { parseAgentModelIds } from "./model-ids";
import { resolveAgentBaseUrl, type AgentProviderTarget } from "./provider";
import { readSavedAgentProvider, readStoredAgentProvider } from "./provider-connections";
import type { AgentProviderPreset } from "./provider-types";
import {
	agentProviderName,
	environmentKeyApplies,
	MAX_PROVIDER_NAME_LENGTH,
	savedAgentModelRates,
	type StoredAgentProvider,
} from "./provider-connection-utils";
import type { AgentProviderValues } from "./provider-connections";
import { AGENT_REASONING_EFFORTS } from "./reasoning-effort-utils";
import type { AGENT_PROVIDER_AUDIT_ACTIONS } from "./provider-constants";

const PROVIDER_PRESET_IDS = ["haimaker", "anthropic", "openai", "openrouter", "groq", "custom"] as const;

export const providerSchema = z.object({
	name: z.string().max(MAX_PROVIDER_NAME_LENGTH).optional(),
	provider: z.enum(["cloudflare", "compatible"]),
	preset: z.enum(PROVIDER_PRESET_IDS),
	baseUrl: z.string().max(500),
	apiKey: z.string().max(2_000).optional(),
	model: z.string().trim().min(1).max(5_000),
	rates: z
		.record(
			z.string(),
			z.object({
				input: z.number().min(0).max(1_000_000).nullable(),
				output: z.number().min(0).max(1_000_000).nullable(),
				reasoningEffort: z.enum(AGENT_REASONING_EFFORTS).nullable().optional(),
			}),
		)
		.optional(),
});

export type AgentProviderInput = z.infer<typeof providerSchema>;

/** The stored provider whose key a blank key field keeps: the one in use, a saved one, or none for a new one. */
async function storedTarget(env: CloudflareEnv, target: AgentProviderTarget): Promise<StoredAgentProvider | null> {
	if (target === "new") return null;
	if (target === "active") return readStoredAgentProvider(env);
	return readSavedAgentProvider(env, target.id);
}

function sameEndpoint(
	env: CloudflareEnv,
	stored: StoredAgentProvider | null,
	next: { preset: AgentProviderPreset; baseUrl: string },
): boolean {
	if (stored?.provider !== "compatible" || (stored.preset ?? "custom") !== next.preset) return false;
	try {
		return resolveAgentBaseUrl(next.preset, stored.baseUrl ?? "", env) === next.baseUrl;
	} catch {
		return false;
	}
}

/** The key a blank key field keeps: the stored one for the same endpoint, or none when `AI_API_KEY` applies. */
async function keptKey(
	env: CloudflareEnv,
	target: AgentProviderTarget,
	next: { preset: AgentProviderPreset; baseUrl: string },
): Promise<{ apiKey: string | null; error?: never } | { error: string; apiKey?: never }> {
	const stored = await storedTarget(env, target);
	const keeps = sameEndpoint(env, stored, next);
	if (keeps && stored?.keyUnreadable) return { error: "The saved API key can't be read. Enter it again." };
	const apiKey = keeps ? (stored?.apiKey ?? null) : null;
	if (!apiKey && !environmentKeyApplies(env, { provider: "compatible", baseUrl: next.baseUrl, apiKey }))
		return { error: "Enter an API key for this provider" };
	return { apiKey };
}

/**
 * Checks a provider form and returns what to store, with the key sealed. A typed key is used as it is, without
 * opening any stored key. A blank key keeps the key stored for the same endpoint (the saved provider `id`, or the
 * provider in use; a new provider has none), or relies on `AI_API_KEY` when the base URL is `AI_BASE_URL`: that key
 * stays in the environment and is never copied into the database.
 */
export async function prepareAgentProviderValues(
	env: CloudflareEnv,
	input: AgentProviderInput,
	target: AgentProviderTarget,
): Promise<{ values: AgentProviderValues; keyReplaced: boolean; error?: never } | { error: string; values?: never }> {
	const modelIds = parseAgentModelIds(input.model);
	if (modelIds.length === 0 || modelIds.length > 20 || modelIds.some((model) => model.length > 200))
		return { error: "Choose 1 to 20 valid model IDs" };
	if (input.provider === "cloudflare" && !env.AI) return { error: "Cloudflare Workers AI binding is unavailable" };
	let baseUrl: string | null = null;
	let apiKey: string | null = null;
	const typedKey = input.provider === "compatible" ? input.apiKey?.trim() || null : null;
	if (input.provider === "compatible") {
		try {
			baseUrl = resolveAgentBaseUrl(input.preset, input.baseUrl, env);
		} catch {
			return { error: "Enter a valid HTTPS provider base URL" };
		}
		const key = typedKey ? { apiKey: typedKey } : await keptKey(env, target, { preset: input.preset, baseUrl });
		if (key.error !== undefined) return { error: key.error };
		apiKey = key.apiKey;
	}
	const preset = input.provider === "compatible" ? input.preset : null;
	return {
		values: {
			name: input.name === undefined ? undefined : agentProviderName(input.name, input.provider, preset),
			provider: input.provider,
			preset,
			baseUrl,
			apiKey: await sealSetting(env, apiKey),
			model: modelIds.join(", "),
			modelRates: savedAgentModelRates(modelIds, input.rates),
		},
		keyReplaced: !!typedKey,
	};
}

type AgentProviderAuditAction = (typeof AGENT_PROVIDER_AUDIT_ACTIONS)[number];

/** Names only: a key or a base URL with a token in it never reaches the audit log. */
export async function auditAgentProvider(
	env: CloudflareEnv,
	actorUserId: string,
	action: AgentProviderAuditAction,
	metadata: { providerId: string; name: string; previous?: string | null; keyReplaced?: boolean },
): Promise<void> {
	await createAuditLog(env, { actorUserId, action, metadata });
}
