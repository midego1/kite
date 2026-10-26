/** The output budget of every chat step, which its spend reservation assumes. */
export const CHAT_STEP_MAX_OUTPUT_TOKENS = 1_200;

export const SPEND_CAP_MESSAGE = "Daily AI spend cap reached";

type PromptMessage = { content: unknown };

function contentChars(content: unknown): number {
	if (typeof content === "string") return content.length;
	return content === undefined || content === null ? 0 : JSON.stringify(content).length;
}

/** The characters a step sends: its system prompt and every message, tool calls and results as their JSON. */
export function stepPromptChars(system: string, messages: readonly PromptMessage[]): number {
	return messages.reduce((sum, message) => sum + contentChars(message.content), system.length);
}
