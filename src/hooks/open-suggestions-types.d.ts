import type { SuggestionKind } from "@/lib/agent/auto-read/suggestion-types";

export type OpenSuggestion = {
	id: string;
	mailboxId: string;
	messageId: string;
	kind: SuggestionKind;
	title: string;
	createdAt: string;
	message: { subject: string | null; from: string | null };
	/** The message as a record ref, and where it opens: `href` is null when the viewer cannot open it. */
	messageRef: { kind: "mail:message"; id: string };
	messageTarget: { href: string | null; label: string };
};

export type SuggestionMailbox = { id: string; address: string; autonomy: string };

export type OpenSuggestionsState = {
	/** False until the first list arrives, so nothing flashes before the user's settings are known. */
	loaded: boolean;
	suggestions: OpenSuggestion[];
	/** Every open suggestion, also when the list stops at its limit. */
	total: number;
	/** The same count per kind, for the For you headings. */
	kindTotals: Partial<Record<SuggestionKind, number>>;
	mailboxes: SuggestionMailbox[];
};
