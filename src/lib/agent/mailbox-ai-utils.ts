/**
 * "No AI for this mailbox", client-safe parts. The gate itself (`aiOffMailboxIds`, `assertMailboxAiAllowed`) is in
 * `mailbox-ai.ts`.
 */

/** The reason code of a job skipped, or a request refused, because AI is off for the mailbox. */
export const MAILBOX_AI_OFF_REASON = "mailbox_ai_off";

/** What a person sees wherever an AI feature would be: plain, and never naming a message, subject or sender. */
export const MAILBOX_AI_OFF_TEXT = "AI is off for this mailbox.";

/** What the assistant's tools answer for a mailbox with AI off, so the model learns nothing about its mail. */
export const MAILBOX_AI_OFF_TOOL_TEXT = "AI is off for this mailbox";

/** Thrown before any model request that would carry mail of a mailbox with AI off; classified as `mailbox_ai_off`. */
export class MailboxAiOffError extends Error {
	constructor() {
		super(MAILBOX_AI_OFF_TOOL_TEXT);
		this.name = "MailboxAiOffError";
	}
}
