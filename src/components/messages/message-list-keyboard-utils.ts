import type { ModifierKey, ShortcutDefinition } from "@/components/shortcuts/types";

/**
 * The row j (`step` 1) or k (`step` -1) moves to: from no focused row, j starts at the first row and k at the
 * last; at either end the focus stays where it is.
 */
export function adjacentRowIndex(count: number, current: number, step: 1 | -1): number {
	if (count === 0) return -1;
	if (current < 0) return step === 1 ? 0 : count - 1;
	return Math.min(count - 1, Math.max(0, current + step));
}

/** The folder list's keys. `useMessageListKeyboard` binds them and the shortcuts sheet lists them. */
export const LIST_KEYS = [
	{ id: "next", key: "j", label: "Next email in the list", category: "Navigation" },
	{ id: "previous", key: "k", label: "Previous email in the list", category: "Navigation" },
	{ id: "open", key: "o", label: "Open email (or Enter)", category: "Navigation" },
	{ id: "select", key: "x", label: "Select email", category: "Selection" },
	{
		id: "extendNext",
		key: "ArrowDown",
		modifiers: ["shift"] as ModifierKey[],
		label: "Extend selection to the next email",
		category: "Selection",
	},
	{
		id: "extendPrevious",
		key: "ArrowUp",
		modifiers: ["shift"] as ModifierKey[],
		label: "Extend selection to the previous email",
		category: "Selection",
	},
	{ id: "archive", key: "e", label: "Archive", category: "Actions" },
	{ id: "trash", key: "#", label: "Move to Trash", category: "Actions" },
] as const satisfies ReadonlyArray<{ id: string } & Omit<ShortcutDefinition, "action">>;

export type ListKeyId = (typeof LIST_KEYS)[number]["id"];

/** The list's key bindings for these handlers. */
export function listShortcuts(actions: Record<ListKeyId, () => void>): ShortcutDefinition[] {
	return LIST_KEYS.map(({ id, ...meta }) => ({ ...meta, action: actions[id] }));
}
