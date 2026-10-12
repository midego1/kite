import type { LanguageModelUsage } from "ai";
import type { AgentModelRates } from "@/lib/agent/provider-types";
import type { AiUsageDetails } from "@/lib/ai/usage-types";

export type AutoSpendSource = "auto_triage" | "auto_draft";

/** "cost" compares USD micros against the caps; "tokens" applies the input-token cap for models without rates. */
export type SpendMode = "cost" | "tokens";

export type SpendEstimate = {
	mode: SpendMode;
	inputTokens: number;
	outputTokens: number;
	costUsdMicros: number | null;
};

export type ReserveAiSpendInput = {
	env: CloudflareEnv;
	details: AiUsageDetails;
	source: AutoSpendSource;
	mailboxId: string;
	jobId: string;
	promptChars: number;
	maxOutputTokens: number;
	installCapMicros: number;
	mailboxCapMicros: number | null;
	now?: Date;
};

export type SpendReservation = SpendEstimate & { id: string };

export type ReconcileAiSpendInput = {
	env: CloudflareEnv;
	reservation: SpendReservation;
	rates: AgentModelRates | undefined;
	/** Usage reported for the call; omit when the call failed without reporting any. */
	usage?: LanguageModelUsage;
};

export type ActualSpend = { inputTokens: number; outputTokens: number; costUsdMicros: number | null };
