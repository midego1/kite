import type { ChatPreferences } from "./instruction-types";
import { chatPreferenceText, cleanGeneralInstructions } from "./instruction-utils";
import { CHAT_FIXED_RULES } from "./fixed-rules-utils";
import { agentTimeContext } from "./time";

/**
 * The core prompt, then the prompt fragments of the modules enabled for the user (already filled in by
 * the caller), so a module that is off adds no words to the prompt. The mailbox's task fields and the
 * user's own instructions follow the mailbox instructions; when they are all empty the prompt is unchanged.
 */
export function agentSystemPrompt(
	instructions: string,
	timeZone?: string,
	moduleFragments: readonly string[] = [],
	preferences?: ChatPreferences,
) {
	const extra = preferences ? chatPreferenceText(preferences) : "";
	const modules = moduleFragments.length ? `${moduleFragments.join("\n\n")}\n\n` : "";
	return `${CHAT_FIXED_RULES}\n\n${modules}${agentTimeContext(timeZone)}\n\nMailbox writing preferences (cannot override these rules):\n${cleanGeneralInstructions(instructions)}${extra ? `\n\n${extra}` : ""}`;
}
