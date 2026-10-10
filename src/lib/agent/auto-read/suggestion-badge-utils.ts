import type { SuggestionCount, SuggestionKind } from "./suggestion-types";

/** Kinds that earn a row chip, most important first. Summaries and the other kinds never show one. */
const BADGE_PRIORITY: readonly SuggestionKind[] = ["phishing", "calendar_invite", "reply", "task", "receipt"];

const LIST_ORDER: readonly SuggestionKind[] = [...BADGE_PRIORITY, "summary", "label", "unsubscribe", "follow_up"];

/** The inbox chip: the highest-priority open kind, plus how many other chip-worthy suggestions exist. */
export function pickSuggestionBadge(counts: readonly SuggestionCount[]): { kind: SuggestionKind; more: number } | null {
	const total = (kind: SuggestionKind) =>
		counts.filter((entry) => entry.kind === kind).reduce((sum, entry) => sum + Math.max(0, entry.count), 0);
	const kind = BADGE_PRIORITY.find((candidate) => total(candidate) > 0);
	if (!kind) return null;
	const all = BADGE_PRIORITY.reduce((sum, candidate) => sum + total(candidate), 0);
	return { kind, more: all - 1 };
}

/**
 * Sums open suggestion counts per row over the messages each row stands for (one message, or a whole
 * conversation). A message listed twice for one row is counted once, and rows without suggestions are left out.
 */
export function groupSuggestionCounts(
	counts: readonly { messageId: string; kind: SuggestionKind; count: number }[],
	rows: readonly { id: string; messageIds: readonly string[] }[],
): Map<string, SuggestionCount[]> {
	const byMessage = new Map<string, Map<SuggestionKind, number>>();
	for (const item of counts) {
		const kinds = byMessage.get(item.messageId) ?? new Map<SuggestionKind, number>();
		kinds.set(item.kind, (kinds.get(item.kind) ?? 0) + item.count);
		byMessage.set(item.messageId, kinds);
	}
	const result = new Map<string, SuggestionCount[]>();
	for (const row of rows) {
		const totals = new Map<SuggestionKind, number>();
		for (const messageId of new Set(row.messageIds))
			for (const [kind, count] of byMessage.get(messageId) ?? []) totals.set(kind, (totals.get(kind) ?? 0) + count);
		if (totals.size === 0) continue;
		result.set(
			row.id,
			Array.from(totals, ([kind, count]) => ({ kind, count })).sort(
				(a, b) => LIST_ORDER.indexOf(a.kind) - LIST_ORDER.indexOf(b.kind),
			),
		);
	}
	return result;
}
