import type { LanguageModelUsage } from "ai";
import type { AgentModelRates } from "@/lib/agent/provider-types";
import type { ActualSpend, SpendEstimate, SpendMode } from "./spend-types";

/**
 * The default daily input-token allowance used when the model has no configured rates, for automatic reading
 * and for chat each (`app_settings.agent_auto_read_token_cap`, `agent_chat_token_cap`).
 */
export const UNKNOWN_RATES_INPUT_TOKEN_CAP = 2_000_000;

/** `ai_usage` sources a person starts; without rates they count against chat's allowance, the rest against automatic reading's. */
export const INTERACTIVE_SPEND_SOURCES: readonly string[] = ["chat", "compose", "summary", "summary_translation"];

export type TokenAllowanceKind = "chat" | "auto_read";

export function tokenAllowanceKind(source: string): TokenAllowanceKind {
	return INTERACTIVE_SPEND_SOURCES.includes(source) ? "chat" : "auto_read";
}

const SECONDS_PER_DAY = 86_400;

/**
 * The flat input and output rates for one request: the long-context tier when the prompt is over its threshold,
 * else the base rates. Null when either base rate is unknown.
 */
export function ratesForPrompt(
	rates: AgentModelRates | undefined,
	inputTokens: number,
): { input: number; output: number } | null {
	if (!rates || rates.input === null || rates.output === null) return null;
	const long = rates.longContext;
	if (long && inputTokens > long.aboveInputTokens) return { input: long.input, output: long.output };
	return { input: rates.input, output: rates.output };
}

function wholeTokens(value: number | undefined): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.ceil(value) : 0;
}

export function spendMode(rates: AgentModelRates | undefined): SpendMode {
	return ratesForPrompt(rates, 0) ? "cost" : "tokens";
}

/** Rates are USD per million tokens, so tokens × rate is already USD micros. */
export function estimateSpend(
	promptChars: number,
	maxOutputTokens: number,
	rates: AgentModelRates | undefined,
): SpendEstimate {
	const inputTokens = Math.ceil(wholeTokens(promptChars) / 4);
	const outputTokens = wholeTokens(maxOutputTokens);
	const priced = ratesForPrompt(rates, inputTokens);
	return {
		mode: priced ? "cost" : "tokens",
		inputTokens,
		outputTokens,
		costUsdMicros: priced ? Math.ceil(inputTokens * priced.input + outputTokens * priced.output) : null,
	};
}

/** Start of the current UTC day in epoch seconds, the unit `ai_usage.created_at` stores. */
export function utcDayStartSeconds(now: Date): number {
	const seconds = Math.floor(now.getTime() / 1000);
	return seconds - (seconds % SECONDS_PER_DAY);
}

/**
 * Some providers report reasoning tokens outside `outputTokens`; billing counts
 * them as output either way, so take whichever total is larger.
 */
function billedOutputTokens(usage: LanguageModelUsage): number {
	const reported = wholeTokens(usage.outputTokens);
	const details = usage.outputTokenDetails;
	const split = wholeTokens(details?.textTokens) + wholeTokens(details?.reasoningTokens);
	return Math.max(reported, split);
}

export function actualSpend(
	mode: SpendMode,
	usage: LanguageModelUsage | undefined,
	rates: AgentModelRates | undefined,
): ActualSpend {
	const inputTokens = usage ? wholeTokens(usage.inputTokens) : 0;
	const outputTokens = usage ? billedOutputTokens(usage) : 0;
	const priced = mode === "cost" ? ratesForPrompt(rates, inputTokens) : null;
	if (mode === "cost" && !priced) return { inputTokens, outputTokens, costUsdMicros: 0 };
	return {
		inputTokens,
		outputTokens,
		costUsdMicros: priced ? Math.round(inputTokens * priced.input + outputTokens * priced.output) : null,
	};
}
