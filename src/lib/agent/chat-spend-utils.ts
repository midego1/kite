import type { SpendCapKind } from "./auto-read/spend-types";

/** The output budget of every chat step, which its spend reservation assumes. */
export const CHAT_STEP_MAX_OUTPUT_TOKENS = 1_200;

/** The caps a refusal message names. */
export type SpendCapLimits = { installCapMicros: number; mailboxCapMicros: number | null; tokenCap: number };

const RESETS = "It resets at 00:00 UTC.";
const dollars = (micros: number) => `$${(micros / 1_000_000).toFixed(2)}`;
const tokens = (count: number) => count.toLocaleString("en-US");

function tokenMessage(who: string, cap: number): string {
	return `Daily AI token allowance reached: ${who} used the ${tokens(cap)} input tokens allowed for today. The model has no prices set, so Kite counts tokens instead of dollars. ${RESETS} The primary admin can raise the allowance, or set model prices, in Admin → Agent.`;
}

/** What a user is told when a cap refuses a request: which cap, when it resets and who can change it where. */
export function spendCapMessage(cap: SpendCapKind, limits: SpendCapLimits): string {
	if (cap === "chat_tokens") return tokenMessage("chat and Write with Kite", limits.tokenCap);
	if (cap === "auto_read_tokens") return tokenMessage("automatic reading", limits.tokenCap);
	if (cap === "mailbox_dollars")
		return `Daily AI spend cap reached: this mailbox's ${dollars(limits.mailboxCapMicros ?? 0)} for today is used up. ${RESETS} Someone who manages the mailbox can change it under Automatic reading in the assistant settings.`;
	return `Daily AI spend cap reached: the install's ${dollars(limits.installCapMicros)} for today is used up. ${RESETS} The primary admin can change it in Admin → Agent.`;
}

type PromptMessage = { content: unknown };

function contentChars(content: unknown): number {
	if (typeof content === "string") return content.length;
	return content === undefined || content === null ? 0 : JSON.stringify(content).length;
}

/** The characters a step sends: its system prompt and every message, tool calls and results as their JSON. */
export function stepPromptChars(system: string, messages: readonly PromptMessage[]): number {
	return messages.reduce((sum, message) => sum + contentChars(message.content), system.length);
}
