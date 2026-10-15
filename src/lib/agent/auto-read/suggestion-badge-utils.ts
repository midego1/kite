import { CLIENT_MODULES } from "@/lib/modules/client-data";
import type { ClientModuleData } from "@/lib/modules/module-types";
import type { CoreSuggestionKind, SuggestionCount, SuggestionKind } from "./suggestion-types";

/** Chip ranks of the core kinds; module kinds slot in by their `badgePriority`. */
const CORE_BADGE_PRIORITY: readonly [CoreSuggestionKind, number][] = [
	["phishing", 10],
	["reply", 30],
	["task", 40],
	["receipt", 50],
];
const CORE_UNRANKED: readonly CoreSuggestionKind[] = ["summary", "label", "unsubscribe", "follow_up"];

type KindRanking = { badge: SuggestionKind[]; order: SuggestionKind[] };

/**
 * The chip-worthy kinds by rank (core and module kinds with a `badgePriority`, ties in declaration
 * order), then every kind most important first: chip kinds, core kinds without a chip, module kinds
 * without a chip.
 * @public Consumed by tests that rank sample module kinds.
 */
export function suggestionKindRanking(modules: readonly Pick<ClientModuleData, "suggestionKindMeta">[]): KindRanking {
	const ranked: [SuggestionKind, number][] = [...CORE_BADGE_PRIORITY];
	const unranked: SuggestionKind[] = [];
	for (const entry of modules)
		for (const [kind, meta] of Object.entries(entry.suggestionKindMeta ?? {}))
			if (typeof meta.badgePriority === "number") ranked.push([kind, meta.badgePriority]);
			else unranked.push(kind);
	const badge = ranked
		.map(([kind, priority], index) => ({ kind, priority, index }))
		.sort((a, b) => a.priority - b.priority || a.index - b.index)
		.map((entry) => entry.kind);
	return { badge, order: [...badge, ...CORE_UNRANKED, ...unranked] };
}

const RANKING = suggestionKindRanking(CLIENT_MODULES);

/** Kinds that earn a row chip, most important first. Summaries and the other kinds never show one. */
const BADGE_PRIORITY: readonly SuggestionKind[] = RANKING.badge;

/** Every kind, most important first; rows and For you list kinds in this order. */
export const SUGGESTION_KIND_ORDER: readonly SuggestionKind[] = RANKING.order;

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
				(a, b) => SUGGESTION_KIND_ORDER.indexOf(a.kind) - SUGGESTION_KIND_ORDER.indexOf(b.kind),
			),
		);
	}
	return result;
}
