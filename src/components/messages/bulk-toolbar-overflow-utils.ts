export type OverflowItem = { id: string; width: number };

/** The flex `gap-2` the toolbar's row uses, in pixels; shared with the measurement hook. */
export const TOOLBAR_GAP_PX = 8;

/**
 * Which of `items`, in priority order (index 0 highest), fit inside `availableWidth` once `reservedWidth`
 * (the selected count, Clear selection and a More actions trigger sized whether or not it ends up rendered)
 * is set aside. Packs greedily and stops at the first item that does not fit: a lower-priority action is
 * never shown ahead of a higher one that had to move to the overflow menu, so the overflow menu's own order
 * stays predictable. `gap` is the row's flex gap, counted once between every pair of adjacent items.
 */
export function packToolbarActions(
	availableWidth: number,
	reservedWidth: number,
	gap: number,
	items: OverflowItem[],
): Set<string> {
	const budget = availableWidth - reservedWidth;
	const visible = new Set<string>();
	let used = 0;
	for (const item of items) {
		const needed = used === 0 ? item.width : used + gap + item.width;
		if (needed > budget) break;
		used = needed;
		visible.add(item.id);
	}
	return visible;
}
