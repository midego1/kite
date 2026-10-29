import type { LanguageModelUsage } from "ai";
import type { AgentModelRates } from "@/lib/agent/provider-types";

export type AiUsageDetails = { modelId: string; provider: string; rates: AgentModelRates | undefined };

/** How a request ended: answered, failed with an error, or stopped (aborted or cut off before usage was reported). */
export type AiUsageStatus = "ok" | "failed" | "stopped";

/** What `ai_usage` records about a settled request besides its tokens and cost (migration 0078). */
export type AiUsageOutcome = {
	status: AiUsageStatus;
	/** The shared AI error code (`ai-error-utils.ts`) of a failed request. */
	errorCode?: string | null;
	durationMs?: number | null;
	finishReason?: string | null;
	/** The USD-per-1M rates the cost was counted at; null when the model had none. */
	rates?: { input: number; output: number } | null;
	/** The stored cost is the reservation's estimate: the request ended before the provider reported its usage. */
	costEstimated?: boolean;
};

export type RecordAiUsageInput = {
	env: CloudflareEnv;
	details: AiUsageDetails;
	/** Missing for a request that failed before reporting usage. */
	usage: LanguageModelUsage | undefined;
	source: string;
	mailboxId?: string | null;
	jobId?: string | null;
	durationMs?: number | null;
	finishReason?: string | null;
	/** A request that failed before reporting usage; `usage` is then empty. */
	failure?: { errorCode: string } | null;
};
