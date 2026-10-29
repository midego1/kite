import type { LanguageModelUsage } from "ai";
import type { AgentModelRates } from "@/lib/agent/provider-types";
import type { AiUsageDetails, AiUsageOutcome } from "@/lib/ai/usage-types";

/**
 * Every source that reserves spend: automatic reading, chat steps, composer requests and the Summarize button and its
 * translations (the install cap covers all).
 */
export type AutoSpendSource =
	| "auto_triage"
	| "auto_draft"
	| "chat"
	| "compose"
	| "summary"
	| "summary_translation"
	| "line_summary"
	| "auto_triage_line";

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
	/** The automatic reading job; null for chat. */
	jobId: string | null;
	promptChars: number;
	maxOutputTokens: number;
	installCapMicros: number;
	mailboxCapMicros: number | null;
	/** The daily input-token allowance of this source's kind (chat or automatic reading), used without model rates. */
	tokenCap: number;
	now?: Date;
};

/** Which daily cap refused a reservation. */
export type SpendCapKind = "chat_tokens" | "auto_read_tokens" | "install_dollars" | "mailbox_dollars";

/** `startedAt` is epoch milliseconds, for the request's duration; `rates` priced the estimate (cost mode only). */
export type SpendReservation = SpendEstimate & {
	id: string;
	startedAt?: number;
	rates?: { input: number; output: number } | null;
};

export type ReconcileAiSpendInput = {
	env: CloudflareEnv;
	reservation: SpendReservation;
	rates: AgentModelRates | undefined;
	/** Usage reported for the call; omit when the call failed without reporting any. */
	usage?: LanguageModelUsage;
	/** How the call ended; by default answered when it reported usage and failed when not. */
	outcome?: Pick<AiUsageOutcome, "status" | "errorCode" | "finishReason">;
};

export type ActualSpend = { inputTokens: number; outputTokens: number; costUsdMicros: number | null };
