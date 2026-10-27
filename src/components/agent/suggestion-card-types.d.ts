import type { ComponentType, ReactNode } from "react";
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
	/** Agent drafts are private to the reviewer; other full-access users see that one exists. */
	canReviewDraft: boolean;
	model: string | null;
	createdAt: string;
};

/** What the card shows for one conversation: the newest summary, then one block per actionable kind. */
export type CardSections = {
	summary: CardSuggestion | null;
	blocks: CardSuggestion[];
	/** The newest answered calendar invitation, which still offers its switch (decline instead or accept instead). */
	answered: CardSuggestion | null;
};

export type SuggestionCardProps = {
	mailboxId: string | null;
	messageId: string;
	threadId: string | null;
	/** A current Summarize summary is on screen, so the automatic-reading summary line stays hidden. */
	hideSummary?: boolean;
};

export type SuggestionCardBodyProps = {
	sections: CardSections;
	onChanged: () => void;
};

export type WhyDetails = { reason: string; model: string };

/** What a module's card block receives; `menu` and `why` are the shared card chrome the block places itself. */
export type SuggestionBlockProps = {
	suggestion: CardSuggestion;
	onChanged: () => void;
	menu: ReactNode;
	why: ReactNode;
};

/** How a module draws one of its suggestion kinds: the open block and, optionally, the block for an answered one. */
export type ModuleSuggestionCard = {
	Block: ComponentType<SuggestionBlockProps>;
	Answered?: ComponentType<Pick<SuggestionBlockProps, "suggestion" | "onChanged">>;
};
