import type { ModuleSearchItem, ModuleSearchSection } from "@/lib/search/module-search-types";

/** Every item in the order the dropdown draws them, which is the order the arrow keys walk. */
export function flattenSections(sections: readonly ModuleSearchSection[]): ModuleSearchItem[] {
	return sections.flatMap((section) => section.items);
}

/** The highlighted row after an arrow key: -1 means none, and the ends do not wrap past the input. */
export function nextActiveIndex(current: number, count: number, key: "ArrowDown" | "ArrowUp"): number {
	if (count === 0) return -1;
	if (key === "ArrowDown") return Math.min(current + 1, count - 1);
	return Math.max(current - 1, -1);
}

export const searchItemKey = (item: ModuleSearchItem) => `${item.ref.kind}:${item.ref.id}`;
