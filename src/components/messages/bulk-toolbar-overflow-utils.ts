export type OverflowItem = { id: string; width: number };

/** The flex `gap-2` the toolbar's row uses, in pixels; shared with the measurement hook. */
export const TOOLBAR_GAP_PX = 8;

/**
 * Which of `items`, in priority order (index 0 highest), fit inside `availableWidth` once `reservedWidth`
 * (the selected count, Clear selection and a More actions trigger sized whether or not it ends up rendered)
 * is set aside. Packs greedily. By default it stops at the first item that does not fit: a lower-priority action
 * is never shown ahead of a higher one that had to move to the overflow menu, so the bulk toolbar's overflow
 * menu keeps a predictable order. With `skipOversized` an item that does not fit is left out and the smaller
 * ones after it are still tried, so a wide label (the reader's "Reply all") cannot leave room for several icon
 * actions unused. `gap` is the row's flex gap, counted once between every pair of adjacent items.
 */
export function packToolbarActions(
	availableWidth: number,
	reservedWidth: number,
	gap: number,
	items: OverflowItem[],
	options: { skipOversized?: boolean } = {},
): Set<string> {
	const budget = availableWidth - reservedWidth;
	const visible = new Set<string>();
	let used = 0;
	for (const item of items) {
		const needed = used === 0 ? item.width : used + gap + item.width;
		if (needed > budget) {
			if (options.skipOversized) continue;
			break;
		}
		used = needed;
		visible.add(item.id);
	}
	return visible;
}
