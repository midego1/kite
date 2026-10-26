import { htmlToReadableText } from "@/lib/email/reply-content-utils";
import { DRAFT_SYSTEM_MARKER } from "../auto-read/request-markers";
import { DRAFT_FIXED_RULES } from "../fixed-rules-utils";
import type { DraftPreferences } from "../instruction-types";
import { draftPreferenceText, GENERAL_INSTRUCTIONS_MAX_CHARS } from "../instruction-utils";

const MESSAGE_CHARS = 2_500;
const THREAD_CHARS = 24_000;
const MAX_DRAFT_CHARS = 40_000;
const META_PREFIX = /^(here is|i have drafted|draft created)/i;

export type DraftThreadMessage = {
	direction: string;
	createdAt: Date;
	textBody: string | null;
	htmlBody: string | null;
};

export type ReplyDraftPrompt = { system: string; prompt: string };

/**
 * The automatic reply prompt; `thread` is oldest first and ends with the message being answered. The mailbox's
 * drafting field and the reviewer's own instructions follow the mailbox preferences; empty ones add nothing.
 */
export function buildReplyDraftPrompt(
	instructions: string,
	thread: DraftThreadMessage[],
	preferences?: DraftPreferences,
): ReplyDraftPrompt {
	const extra = preferences ? draftPreferenceText(preferences) : "";
	const conversation = thread
		.map(
			(row) =>
				`${row.direction === "inbound" ? "Sender" : "Mailbox"} (${row.createdAt.toISOString()}): ${(row.textBody || htmlToReadableText(row.htmlBody)).slice(0, MESSAGE_CHARS)}`,
		)
		.join("\n\n");
	return {
		system: `${DRAFT_SYSTEM_MARKER} ${DRAFT_FIXED_RULES} Mailbox preferences: ${instructions.slice(0, GENERAL_INSTRUCTIONS_MAX_CHARS)}${extra ? `\n\n${extra}` : ""}`,
		prompt: `Reply to the latest inbound email in this conversation:\n${conversation.slice(-THREAD_CHARS)}`,
	};
}

/** False for an empty or oversized reply, or one that talks about the draft instead of being it. */
export function isCleanDraftBody(body: string): boolean {
	return !!body && body.length <= MAX_DRAFT_CHARS && !META_PREFIX.test(body);
}
