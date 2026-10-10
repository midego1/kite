import type { SuggestionKind, SuggestionStatus } from "@/lib/agent/auto-read/suggestion-types";

/** A suggestion as `GET /api/agent/suggestions` returns it, limited to what the reader card uses. */
export type CardSuggestion = {
	id: string;
	mailboxId: string;
	messageId: string;
	threadId: string | null;
	kind: SuggestionKind;
	status: SuggestionStatus;
	title: string;
	payload: Record<string, unknown>;
	draftId: string | null;
	model: string | null;
	createdAt: string;
};

/** What the card shows for one conversation: the newest summary, then one block per actionable kind. */
export type CardSections = {
	summary: CardSuggestion | null;
	blocks: CardSuggestion[];
};

export type SuggestionCardProps = {
	mailboxId: string | null;
	messageId: string;
	threadId: string | null;
};

export type SuggestionCardBodyProps = {
	sections: CardSections;
	onChanged: () => void;
};

export type WhyDetails = { reason: string; model: string };
