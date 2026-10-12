import type { ReorderableLayout } from "./reorderable-list-types";

/**
 * Saved placement first (dropping ids that no longer exist or repeat). An item the layout has never
 * seen goes into its default list right after its nearest earlier default neighbour that list still
 * holds, otherwise right before its nearest later one, otherwise at the end.
 */
export function resolveLayout(defaults: ReorderableLayout, stored: ReorderableLayout): ReorderableLayout {
	const known = new Set(Object.values(defaults).flat());
	const placed = new Set<string>();
	const layout: ReorderableLayout = {};
	for (const listId of Object.keys(defaults)) {
		layout[listId] = (stored[listId] ?? []).filter((id) => known.has(id) && !placed.has(id) && !!placed.add(id));
	}
	for (const [listId, ids] of Object.entries(defaults)) {
		ids.forEach((id, index) => {
			if (placed.has(id)) return;
			layout[listId].splice(insertionIndex(layout[listId], ids, index), 0, id);
			placed.add(id);
		});
	}
	return layout;
}

function insertionIndex(list: string[], defaults: string[], index: number): number {
	for (let before = index - 1; before >= 0; before--) {
		const at = list.indexOf(defaults[before]);
		if (at >= 0) return at + 1;
	}
	for (let after = index + 1; after < defaults.length; after++) {
		const at = list.indexOf(defaults[after]);
		if (at >= 0) return at;
	}
	return list.length;
}

/** Take `id` out of whichever list holds it and insert it into `listId` before `beforeId` (end when null). */
export function moveItem(
	layout: ReorderableLayout,
	id: string,
	listId: string,
	beforeId: string | null,
): ReorderableLayout {
	const next: ReorderableLayout = {};
	for (const [key, ids] of Object.entries(layout)) next[key] = ids.filter((item) => item !== id);
	const target = next[listId] ?? [];
	const index = beforeId === null ? -1 : target.indexOf(beforeId);
	if (index < 0) target.push(id);
	else target.splice(index, 0, id);
	next[listId] = target;
	return next;
}

export function readStorage<T>(key: string, fallback: T): T {
	try {
		const raw = localStorage.getItem(key);
		return raw === null ? fallback : (JSON.parse(raw) as T);
	} catch {
		return fallback;
	}
}

export function writeStorage(key: string, value: unknown) {
	try {
		localStorage.setItem(key, JSON.stringify(value));
	} catch {
		// Storage can be unavailable (private windows); the setting just won't persist.
	}
}
