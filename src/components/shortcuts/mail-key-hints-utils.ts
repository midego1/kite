import type { ShortcutHint } from "./types";

/**
 * The mail keys, bound by the message list (`use-message-list-keyboard.ts`) and the reader
 * (`message-shortcuts.ts`, `message-detail-navigation.tsx`) while those are on screen.
 */
const MAIL_KEY_HINTS: ShortcutHint[] = [
	{ key: "j", label: "Next / older email", category: "Navigation" },
	{ key: "k", label: "Previous / newer email", category: "Navigation" },
	{ key: "o", label: "Open email (or Enter)", category: "Navigation" },
	{ key: "u", label: "Back to List", category: "Navigation" },
	{ key: "x", label: "Select email", category: "Selection" },
	{ key: "e", label: "Archive", category: "Actions" },
	{ key: "#", label: "Move to Trash", category: "Actions" },
	{ key: "!", label: "Report spam", category: "Actions" },
	{ key: "r", label: "Reply", category: "Composing" },
	{ key: "a", label: "Reply all", category: "Composing" },
	{ key: "f", label: "Forward", category: "Composing" },
];

/** The provider's bindings followed by the mail keys they do not already list. */
export function withMailKeyHints(bindings: ShortcutHint[]): ShortcutHint[] {
	const listed = new Set(bindings.map((binding) => binding.key.toLowerCase()));
	return [...bindings, ...MAIL_KEY_HINTS.filter((hint) => !listed.has(hint.key))];
}
