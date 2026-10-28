import { getDb } from "@/db";
import { aiUsage } from "@/db/schema";
import { newId } from "@/lib/ids";
import { calculateAgentCostUsdMicros } from "@/lib/agent/pricing";
import { ratesForPrompt } from "@/lib/agent/auto-read/spend-utils";
import { updateAiUsage } from "./usage-details";
import type { RecordAiUsageInput } from "./usage-types";

export async function recordAiUsage({
	env,
	details,
	usage,
	source,
	mailboxId,
	jobId,
	durationMs,
	finishReason,
	failure,
}: RecordAiUsageInput) {
	try {
		const id = newId("usage");
		const cost = usage ? calculateAgentCostUsdMicros(usage, details.rates) : null;
		await getDb(env)
			.insert(aiUsage)
			.values({
				id,
				provider: details.provider,
				model: details.modelId,
				source,
				inputTokens: usage?.inputTokens ?? null,
				outputTokens: usage?.outputTokens ?? null,
				costUsdMicros: cost,
				mailboxId: mailboxId ?? null,
				jobId: jobId ?? null,
			});
		await updateAiUsage(env, id, "", [], {
			...(failure ? { status: "failed", errorCode: failure.errorCode } : { status: "ok" }),
			durationMs,
			finishReason,
			rates: cost === null ? null : ratesForPrompt(details.rates, usage?.inputTokens ?? 0),
		});
	} catch (error) {
		console.error("Could not record AI usage", error);
	}
}
