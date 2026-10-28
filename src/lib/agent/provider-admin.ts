import { z } from "zod";
import { createAuditLog } from "@/lib/mailboxes/audit";
import { sealSetting } from "@/lib/security/secret-box";
import { parseAgentModelIds } from "./model-ids";
import { getTargetAgentProviderConfig, resolveAgentBaseUrl, type AgentProviderTarget } from "./provider";
import { agentProviderName, MAX_PROVIDER_NAME_LENGTH, savedAgentModelRates } from "./provider-connection-utils";
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

/**
 * Checks a provider form and returns what to store, with the key sealed. A blank key keeps the one stored for the
 * same endpoint: the saved provider `id`, or the provider in use when `id` is null (a new provider has none).
 */
export async function prepareAgentProviderValues(
	env: CloudflareEnv,
	input: AgentProviderInput,
	target: AgentProviderTarget,
): Promise<{ values: AgentProviderValues; error?: never } | { error: string; values?: never }> {
	const modelIds = parseAgentModelIds(input.model);
	if (modelIds.length === 0 || modelIds.length > 20 || modelIds.some((model) => model.length > 200))
		return { error: "Choose 1 to 20 valid model IDs" };
	if (input.provider === "cloudflare" && !env.AI) return { error: "Cloudflare Workers AI binding is unavailable" };
	let baseUrl: string | null = null;
	let apiKey: string | null = null;
	if (input.provider === "compatible") {
		try {
			baseUrl = resolveAgentBaseUrl(input.preset, input.baseUrl, env);
		} catch {
			return { error: "Enter a valid HTTPS provider base URL" };
		}
		const current = await getTargetAgentProviderConfig(env, target);
		apiKey =
			input.apiKey?.trim() ||
			(current?.provider === "compatible" && current.preset === input.preset && current.baseUrl === baseUrl
				? current.apiKey
				: "") ||
			null;
		if (!apiKey) return { error: "Enter an API key for this provider" };
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
	};
}

type AgentProviderAuditAction = (typeof AGENT_PROVIDER_AUDIT_ACTIONS)[number];

/** Names only: a key or a base URL with a token in it never reaches the audit log. */
export async function auditAgentProvider(
	env: CloudflareEnv,
	actorUserId: string,
	action: AgentProviderAuditAction,
	metadata: { providerId: string; name: string; previous?: string | null },
): Promise<void> {
	await createAuditLog(env, { actorUserId, action, metadata });
}
