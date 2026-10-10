import type { SuggestionKind } from "@/lib/agent/auto-read/suggestion-types";
import type { CardSections, CardSuggestion, WhyDetails } from "./suggestion-card-types";

/** Kinds that get their own block in the reader card, in display order; calendar invites join later. */
const BLOCK_KINDS: readonly SuggestionKind[] = ["phishing", "reply"];

const REASON_TEXT: Record<string, string> = {
	needs_reply: "The message asks you something that needs an answer.",
	long_thread: "The message or conversation is long, so Kite summarised it.",
	phishing_signals: "The message shows signs of phishing.",
	calendar_invite: "The message contains a calendar invitation.",
};

/**
 * The open suggestions of the whole conversation, so one made for an earlier message still shows
 * when a later one is opened. Without a thread the message's own suggestions are listed.
 */
export function suggestionCardUrl(messageId: string, threadId: string | null): string {
	const params = new URLSearchParams({ status: "open" });
	if (threadId) params.set("threadId", threadId);
	else params.set("messageId", messageId);
	return `/api/agent/suggestions?${params}`;
}

/**
 * Picks what the card shows from suggestions listed newest first: the newest summary and the newest
 * open suggestion of each block kind, all from the message's own mailbox (thread ids are per mailbox).
 */
export function cardSections(suggestions: readonly CardSuggestion[], mailboxId: string | null): CardSections {
	const open = suggestions.filter((item) => item.status === "open" && item.mailboxId === mailboxId);
	const blocks: CardSuggestion[] = [];
	for (const kind of BLOCK_KINDS) {
		const newest = open.find((item) => item.kind === kind);
		if (newest) blocks.push(newest);
	}
	return { summary: open.find((item) => item.kind === "summary") ?? null, blocks };
}

export function hasCardContent(sections: CardSections): boolean {
	return sections.summary !== null || sections.blocks.length > 0;
}

export function summaryText(suggestion: CardSuggestion): string {
	const text = suggestion.payload.text;
	return typeof text === "string" ? text : "";
}

/** The policy rule behind a suggestion in plain words, and the model that read the message. */
export function whyDetails(suggestion: CardSuggestion): WhyDetails {
	const reason = suggestion.payload.reason;
	return {
		reason: (typeof reason === "string" && REASON_TEXT[reason]) || "Kite's rules for this mailbox suggested this.",
		model: suggestion.model ? `Read by ${suggestion.model}.` : "Found by Kite's rules, without a model.",
	};
}
