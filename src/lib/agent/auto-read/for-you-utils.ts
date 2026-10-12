import { SUGGESTION_KIND_ORDER } from "./suggestion-badge-utils";
import type { SuggestionKind } from "./suggestion-types";

export const FOR_YOU_KIND_LABELS: Record<SuggestionKind, string> = {
	phishing: "Possible phishing",
	calendar_invite: "Invitations",
	reply: "Replies to review",
	task: "Tasks",
	receipt: "Receipts",
	summary: "Summaries",
	label: "Labels",
	unsubscribe: "Unsubscribe",
	follow_up: "Follow-ups",
};

type Listed = { id: string; kind: SuggestionKind; createdAt: string };

/** One group per kind in importance order, each newest first (ties keep the API's order). */
export function groupForYou<T extends Listed>(items: readonly T[]): { kind: SuggestionKind; items: T[] }[] {
	const groups = new Map<SuggestionKind, T[]>();
	for (const item of items) groups.set(item.kind, [...(groups.get(item.kind) ?? []), item]);
	const rank = (kind: SuggestionKind) => {
		const index = SUGGESTION_KIND_ORDER.indexOf(kind);
		return index < 0 ? SUGGESTION_KIND_ORDER.length : index;
	};
	return Array.from(groups, ([kind, entries]) => ({
		kind,
		items: entries
			.map((item, index) => ({ item, index, time: Date.parse(item.createdAt) || 0 }))
			.sort((a, b) => b.time - a.time || a.index - b.index)
			.map((entry) => entry.item),
	})).sort((a, b) => rank(a.kind) - rank(b.kind));
}

/** For you is offered while at least one full-access mailbox has automatic reading on. */
export function forYouVisible(mailboxes: readonly { autonomy: string }[]): boolean {
	return mailboxes.some((mailbox) => mailbox.autonomy !== "off");
}

/** The selection after a list change: ids that are no longer listed drop out. */
export function keepListedSelection(selected: ReadonlySet<string>, items: readonly { id: string }[]): Set<string> {
	const listed = new Set(items.map((item) => item.id));
	return new Set([...selected].filter((id) => listed.has(id)));
}
