import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createWorkersAI } from "workers-ai-provider";
import { getAgentProviderConfig } from "./provider";
import { COMPATIBLE_PROVIDER_NAME } from "./auto-read/model-call-utils";
import { withDedupedStreams } from "./workers-ai-stream-utils";

export async function getAgentModel(env: CloudflareEnv, requestedModel?: string | null) {
	const config = await getAgentProviderConfig(env);
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
		return env.AI ? { model: createWorkersAI({ binding: withDedupedStreams(env.AI) })(modelId), ...details } : null;
	if (config.baseUrl && config.apiKey && modelId) {
		if (config.preset === "anthropic") {
			const provider = createAnthropic({ apiKey: config.apiKey, baseURL: config.baseUrl });
			return { model: provider(modelId), ...details };
		}
		const provider = createOpenAICompatible({
			name: COMPATIBLE_PROVIDER_NAME,
			baseURL: config.baseUrl,
			apiKey: config.apiKey,
		});
		return { model: provider.chatModel(modelId), ...details };
	}
	return null;
}
