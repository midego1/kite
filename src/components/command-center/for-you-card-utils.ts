import { getEmailDisplayName } from "@/lib/email/address";
import { forYouVisible } from "@/lib/agent/auto-read/for-you-utils";
import type { OpenSuggestion, SuggestionMailbox } from "@/hooks/open-suggestions-types";
import { CLIENT_MODULES } from "@/lib/modules/client-data";

/** The suggestions the card lists, at most; the rest is "n more" and the For you page. */
export const FOR_YOU_CARD_LIMIT = 4;

/** How a kind reads in one row ("Reply", "Phishing"): the row chip's wording where there is one. */
const CORE_KIND_LABELS: Readonly<Record<string, string>> = {
	phishing: "Phishing",
	reply: "Reply",
	task: "Task",
	receipt: "Receipt",
	summary: "Summary",
	label: "Label",
	unsubscribe: "Unsubscribe",
	follow_up: "Follow-up",
};

const MODULE_KIND_LABELS: Readonly<Record<string, string>> = Object.fromEntries(
	CLIENT_MODULES.flatMap((entry) =>
		Object.entries(entry.suggestionKindMeta ?? {}).map(([kind, meta]) => [kind, meta.badgeLabel ?? meta.label]),
	),
);

/** The kind's name in a row; a kind nobody labelled reads as itself. */
export function forYouKindLabel(kind: string): string {
	return MODULE_KIND_LABELS[kind] ?? CORE_KIND_LABELS[kind] ?? kind;
}

export type ForYouCardRow = {
	id: string;
	mailboxId: string;
	kind: string;
	kindLabel: string;
	/** The message's subject, else the suggestion's own title. */
	subject: string;
	/** What Kite noticed, shown when the subject is there too. */
	title: string;
	/** The sender's name, else their address; empty when unknown. */
	sender: string;
	createdAt: string;
	/** Where the message opens, null when the viewer cannot open it. */
	href: string | null;
};

export type ForYouCardView = {
	/** False until the list is known and while no mailbox in view reads mail automatically. */
	visible: boolean;
	rows: ForYouCardRow[];
	/** Open suggestions in the mailboxes in view, also those not listed. */
	count: number;
	/** Suggestions beyond the listed rows. */
	more: number;
};

/**
 * What the command center's For you card shows: the newest open suggestions of the mailboxes the mail views list
 * right now (one mailbox, or the All mailboxes view's). The server has already left out mailboxes with "No AI",
 * suggestions of modules that are off for the user, reviewer-only kinds of other reviewers and mailboxes without
 * full access. The card is hidden until the list has arrived and while every mailbox in view has automatic
 * reading off, as the For you sidebar item is. The count is the list's own total when every mailbox it covers is
 * in view, else what the (200-row) list holds for the mailboxes in view.
 */
export function forYouCardView(
	state: {
		loaded: boolean;
		suggestions: readonly OpenSuggestion[];
		total: number;
		mailboxes: readonly SuggestionMailbox[];
	},
	viewMailboxIds: readonly string[],
	limit = FOR_YOU_CARD_LIMIT,
): ForYouCardView {
	const inView = new Set(viewMailboxIds);
	const covered = state.mailboxes.filter((mailbox) => inView.has(mailbox.id));
	if (!state.loaded || !forYouVisible(covered)) return { visible: false, rows: [], count: 0, more: 0 };
	const listed = state.suggestions
		.filter((suggestion) => inView.has(suggestion.mailboxId))
		.map((suggestion, index) => ({ suggestion, index, time: Date.parse(suggestion.createdAt) || 0 }))
		.sort((a, b) => b.time - a.time || a.index - b.index)
		.map((entry) => entry.suggestion);
	const everything = covered.length === state.mailboxes.length;
	const count = everything ? Math.max(state.total, listed.length) : listed.length;
	const rows = listed.slice(0, limit).map((suggestion): ForYouCardRow => ({
		id: suggestion.id,
		mailboxId: suggestion.mailboxId,
		kind: suggestion.kind,
		kindLabel: forYouKindLabel(suggestion.kind),
		subject: suggestion.message.subject?.trim() || suggestion.title || "(No subject)",
		title: suggestion.title,
		sender: suggestion.message.from ? getEmailDisplayName(suggestion.message.from) : "",
		createdAt: suggestion.createdAt,
		href: suggestion.messageTarget.href,
	}));
	return { visible: true, rows, count, more: Math.max(0, count - rows.length) };
}
