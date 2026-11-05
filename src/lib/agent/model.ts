import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createWorkersAI } from "workers-ai-provider";
import { wrapLanguageModel } from "ai";
import { getAgentProviderConfig } from "./provider";
import { AgentProviderKeyUnreadableError } from "./provider-connections";
import { COMPATIBLE_PROVIDER_NAME } from "./auto-read/model-call-utils";
import { withDedupedStreams } from "./workers-ai-stream-utils";
import { assertMailboxAiAllowed } from "./mailbox-ai";

/** Whose mail a model request carries, and the model it asks for. */
export type AgentModelRequest = { mailboxId: string; modelId?: string | null };

type ProviderModel = Parameters<typeof wrapLanguageModel>[0]["model"];

/**
 * The model with the mailbox's switch checked again before every provider call it makes: a chat step, a repair, a
 * parameter fallback or a retry, however long after the selection that call comes.
 */
function gated(env: CloudflareEnv, mailboxId: string, model: ProviderModel) {
	return wrapLanguageModel({
		model,
		middleware: {
			wrapGenerate: async ({ doGenerate }) => {
				await assertMailboxAiAllowed(env, mailboxId);
				return doGenerate();
			},
			wrapStream: async ({ doStream }) => {
				await assertMailboxAiAllowed(env, mailboxId);
				return doStream();
			},
		},
	});
}

/**
 * The model for one request, and the only place a provider client is made. It refuses with `MailboxAiOffError`
 * when AI is off for the mailbox whose mail the request carries ("No AI for this mailbox"), so no path can reach a
 * provider without passing that check (`tests/mailbox-ai-gate.test.mjs` scans for model calls that bypass it), and
 * the returned model checks it again before each call (`gated`).
 */
export async function getAgentModel(env: CloudflareEnv, request: AgentModelRequest) {
	const { mailboxId, modelId: requestedModel } = request;
	await assertMailboxAiAllowed(env, mailboxId);
	const config = await getAgentProviderConfig(env);
	if (config.keyUnreadable) throw new AgentProviderKeyUnreadableError();
	const modelId = requestedModel && config.models.includes(requestedModel) ? requestedModel : config.model;
	const details = {
		modelId,
		/** The label usage rows record: "cloudflare" or the compatible preset. */
		provider: config.provider === "cloudflare" ? "cloudflare" : config.preset,
		preset: config.preset,
		providerKind: config.provider,
		rates: config.effectiveRates[modelId],
		reasoningEffort: config.rates[modelId]?.reasoningEffort ?? null,
	};
	if (config.provider === "cloudflare")
		return env.AI
			? { model: gated(env, mailboxId, createWorkersAI({ binding: withDedupedStreams(env.AI) })(modelId)), ...details }
			: null;
	if (config.baseUrl && config.apiKey && modelId) {
		if (config.preset === "anthropic") {
			const provider = createAnthropic({ apiKey: config.apiKey, baseURL: config.baseUrl });
			return { model: gated(env, mailboxId, provider(modelId)), ...details };
		}
		const provider = createOpenAICompatible({
			name: COMPATIBLE_PROVIDER_NAME,
			baseURL: config.baseUrl,
			apiKey: config.apiKey,
		});
		return { model: gated(env, mailboxId, provider.chatModel(modelId)), ...details };
	}
	return null;
}
