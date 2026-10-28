import { integer, text } from "drizzle-orm/sqlite-core";

/**
 * The instruction columns `mailbox_agent_settings` and `user_ai_settings` share: the general instructions and
 * (migration 0069) preferences for chat, drafting and summaries, added to the system prompt in that order.
 */
export function instructionColumns() {
	return {
		instructions: text("instructions").notNull().default(""),
		chatInstructions: text("chat_instructions").notNull().default(""),
		draftInstructions: text("draft_instructions").notNull().default(""),
		summaryInstructions: text("summary_instructions").notNull().default(""),
	};
}

/**
 * The columns only `mailbox_agent_settings` has after its instructions: the one-line summaries in the message list
 * (migration 0072), off by default, newsletters only when allowed, and their daily limit.
 */
export function mailboxAgentExtraColumns() {
	return {
		...instructionColumns(),
		listSummaries: integer("list_summaries", { mode: "boolean" }).notNull().default(false),
		listSummariesBulk: integer("list_summaries_bulk", { mode: "boolean" }).notNull().default(false),
		listSummaryDailyLimit: integer("list_summary_daily_limit").notNull().default(100),
	};
}

/**
 * The assistant's install-wide daily caps on `app_settings`: the dollar cap that automatic reading and chat share,
 * and (migration 0069) the input-token allowances used without model rates, one for automatic reading and one for
 * chat, so neither can use up the other's.
 */
export function agentSpendCapColumns() {
	return {
		agentDailySpendCapMicros: integer("agent_daily_spend_cap_micros").notNull().default(2_000_000),
		agentAutoReadTokenCap: integer("agent_auto_read_token_cap").notNull().default(2_000_000),
		agentChatTokenCap: integer("agent_chat_token_cap").notNull().default(2_000_000),
	};
}
