import type { LayoutLabelColor, LayoutLabelColors } from "@/lib/preferences/layout-types";

export const LABEL_COLORS_STORAGE_KEY = "kite-label-colors";

/**
 * The palette for the dots and icons that mark a mailbox or a connected account in the message list. Each colour keeps
 * at least 3:1 against every row background in light and dark (white to the selected row's grey, and the dark themes'
 * greys, Kite classic's selected row included), which `tests/label-colors.test.mjs` checks; the Kite and Classic palettes both stay inside those greys.
 */
export const LABEL_COLORS: readonly { id: LayoutLabelColor; label: string; value: string }[] = [
	{ id: "blue", label: "Blue", value: "#4a82f2" },
	{ id: "purple", label: "Purple", value: "#9c69f4" },
	{ id: "pink", label: "Pink", value: "#e64a92" },
	{ id: "red", label: "Red", value: "#e65454" },
	{ id: "orange", label: "Orange", value: "#e6570c" },
	{ id: "amber", label: "Amber", value: "#c5710a" },
	{ id: "green", label: "Green", value: "#1f9a46" },
	{ id: "teal", label: "Teal", value: "#25958d" },
];

const VALUE_OF = new Map(LABEL_COLORS.map((color) => [color.id, color.value]));

const labelColorValue = (id: LayoutLabelColor): string => VALUE_OF.get(id) ?? LABEL_COLORS[0].value;

function hashIndex(id: string): number {
	let hash = 0;
	for (let i = 0; i < id.length; i++) hash = (Math.imul(hash, 31) + id.charCodeAt(i)) | 0;
	return (hash >>> 0) % LABEL_COLORS.length;
}

/**
 * The automatic colours of a set of mailboxes (all the ones the user can open): each takes the palette colour its id
 * hashes to, taken in id order, and a mailbox whose colour is already taken moves on to the next free one. So the
 * colours are distinct while there are no more mailboxes than colours, nothing depends on how they are listed, and a
 * mailbox keeps its colour when another is added unless the newcomer's id sorts before it and wants the same slot.
 * Choosing a colour for a mailbox pins it.
 */
export function automaticMailboxColors(ids: readonly string[]): Map<string, LayoutLabelColor> {
	const colors = new Map<string, LayoutLabelColor>();
	const taken = new Set<number>();
	for (const id of [...ids].sort()) {
		const start = hashIndex(id);
		let index = start;
		for (let step = 0; step < LABEL_COLORS.length && taken.has(index); step++)
			index = (index + 1) % LABEL_COLORS.length;
		if (taken.has(index)) index = start;
		taken.add(index);
		colors.set(id, LABEL_COLORS[index].id);
	}
	return colors;
}

/** The colour of a mailbox's mark: the one chosen for it, else its automatic colour (from `automatic`). */
export function mailboxLabelColor(
	colors: LayoutLabelColors | undefined,
	mailbox: { id: string },
	automatic: ReadonlyMap<string, LayoutLabelColor>,
): { id: LayoutLabelColor; value: string; chosen: boolean } {
	const chosen = colors?.mailboxes?.[mailbox.id];
	const id = chosen ?? automatic.get(mailbox.id) ?? LABEL_COLORS[hashIndex(mailbox.id)].id;
	return { id, value: labelColorValue(id), chosen: chosen !== undefined };
}

/** The colour chosen for a connected account's icon, or null for the neutral one. */
export function accountLabelColor(colors: LayoutLabelColors | undefined, accountId: string): string | null {
	const chosen = colors?.accounts?.[accountId];
	return chosen ? labelColorValue(chosen) : null;
}

/** The colours with one entry set, or removed for `null` (back to the automatic colour or the neutral icon). */
export function withLabelColor(
	colors: LayoutLabelColors | undefined,
	kind: "mailboxes" | "accounts",
	id: string,
	color: LayoutLabelColor | null,
): LayoutLabelColors {
	const map = { ...colors?.[kind] };
	if (color) map[id] = color;
	else delete map[id];
	const next: LayoutLabelColors = { ...colors };
	if (Object.keys(map).length) next[kind] = map;
	else delete next[kind];
	return next;
}

/**
 * The colours without entries for mailboxes or accounts that are gone. A kind whose list is not known yet (`undefined`)
 * is left whole, so a list that is still loading, or failed, never wipes the user's choices.
 */
export function pruneLabelColors(
	colors: LayoutLabelColors,
	known: { mailboxes?: readonly string[]; accounts?: readonly string[] },
): LayoutLabelColors {
	const next: LayoutLabelColors = { ...colors };
	for (const kind of ["mailboxes", "accounts"] as const) {
		const ids = known[kind];
		const map = colors[kind];
		if (!ids || !map) continue;
		const present = new Set(ids);
		const kept = Object.fromEntries(Object.entries(map).filter(([id]) => present.has(id)));
		if (Object.keys(kept).length) next[kind] = kept;
		else delete next[kind];
	}
	return next;
}

/** Whether pruning would change anything, so the cleanup saves only when it has something to remove. */
export function hasStaleLabelColors(
	colors: LayoutLabelColors,
	known: { mailboxes?: readonly string[]; accounts?: readonly string[] },
): boolean {
	const pruned = pruneLabelColors(colors, known);
	return (
		Object.keys(pruned.mailboxes ?? {}).length !== Object.keys(colors.mailboxes ?? {}).length ||
		Object.keys(pruned.accounts ?? {}).length !== Object.keys(colors.accounts ?? {}).length
	);
}

/** Reads the browser's stored colours; anything unreadable is none chosen. */
export function parseStoredLabelColors(raw: string | null): LayoutLabelColors {
	if (!raw) return {};
	try {
		const parsed: unknown = JSON.parse(raw);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? sanitize(parsed as LayoutLabelColors) : {};
	} catch {
		return {};
	}
}

const COLOR_IDS = new Set<string>(LABEL_COLORS.map((color) => color.id));

function sanitize(colors: LayoutLabelColors): LayoutLabelColors {
	const clean: LayoutLabelColors = {};
	for (const kind of ["mailboxes", "accounts"] as const) {
		const map = colors[kind];
		if (!map || typeof map !== "object" || Array.isArray(map)) continue;
		const kept = Object.fromEntries(
			Object.entries(map).filter(([id, color]) => id && typeof color === "string" && COLOR_IDS.has(color)),
		) as Record<string, LayoutLabelColor>;
		if (Object.keys(kept).length) clean[kind] = kept;
	}
	return clean;
}
