import { text } from "drizzle-orm/sqlite-core";

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
