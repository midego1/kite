import type { AuthMeUser } from "@/lib/auth/me-client-types";
import type { NavMode } from "@/components/settings/section-nav-types";
import { navModeLabels, searchNavAcrossModes } from "@/components/settings/section-nav-utils";
import type { PageSearchGroup, PageSearchResult } from "./page-search-types";

export function pageSearchPlaceholder(mode: NavMode): string {
	return `Search ${navModeLabels[mode].toLowerCase()}`;
}

/** Pages from both menus matching `query`, grouped by menu with the current one first; nothing for a blank query. */
export function searchPages(query: string, user: AuthMeUser | null, mode: NavMode): PageSearchGroup[] {
	if (!query.trim()) return [];
	let index = 0;
	return searchNavAcrossModes(query, user, mode).map((group) => ({
		mode: group.mode,
		results: group.sections.flatMap((section) =>
			section.items.map((item) => ({
				id: `page-search-option-${index++}`,
				href: item.href,
				label: item.label,
				icon: item.icon,
				mode: group.mode,
				section: section.label,
			})),
		),
	}));
}

/** The results in the order they are listed, which is the order the arrow keys walk. */
export function flattenPageResults(groups: PageSearchGroup[]): PageSearchResult[] {
	return groups.flatMap((group) => group.results);
}

/** The next highlighted index, wrapping at both ends; -1 means nothing is highlighted. */
export function moveHighlight(index: number, count: number, direction: "up" | "down"): number {
	if (count === 0) return -1;
	if (direction === "down") return index < 0 || index >= count - 1 ? 0 : index + 1;
	return index <= 0 || index >= count ? count - 1 : index - 1;
}

/** The result Enter opens: the highlighted one, else the first, else none. */
export function resultToOpen(results: PageSearchResult[], index: number): PageSearchResult | undefined {
	return results[index] ?? results[0];
}
