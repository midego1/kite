import type { ShortcutDefinition } from "./types";

const MODIFIER_KEYS = new Set(["shift", "control", "alt", "meta", "altgraph", "capslock", "os"]);

/** Pressing a modifier on its own (Shift before `!`, for example) is not a step of a key sequence. */
export function isModifierKey(key: string): boolean {
	return MODIFIER_KEYS.has(key.toLowerCase());
}

/** A single printable character that is not a letter or digit, such as `#`, `/` or `€`. */
function isTypedSymbol(key: string): boolean {
	return [...key].length === 1 && !/[\p{L}\p{N}\s]/u.test(key);
}

/**
 * Whether a key press is a browser or OS chord (Cmd+C, Ctrl+F, Alt+F) that page shortcuts must leave alone, so
 * its key never fires a one-key shortcut or starts a sequence. A symbol typed with Alt is not a chord: Windows
 * reports AltGr as Ctrl+Alt, and AltGr+3 types `#` on French AZERTY just as Option+3 does on a British Mac.
 */
export function isBrowserChord(event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey">): boolean {
	if (event.metaKey) return true;
	if (!event.ctrlKey && !event.altKey) return false;
	return !(event.altKey && isTypedSymbol(event.key));
}

/**
 * The Cmd/Ctrl shortcut a chord presses, such as `p` with `["meta", "ctrl"]` for either. Alt never matches, and
 * Shift only when the shortcut asks for it, so Ctrl+Shift+P (a new private window in Firefox) stays the browser's.
 */
export function findChordMatch(
	event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
	shortcuts: readonly ShortcutDefinition[],
): ShortcutDefinition | undefined {
	if (event.altKey || !(event.metaKey || event.ctrlKey)) return undefined;
	const key = event.key.toLowerCase();
	return shortcuts.find((shortcut) => {
		const modifiers = shortcut.modifiers ?? [];
		if (shortcut.key.toLowerCase() !== key || modifiers.includes("alt")) return false;
		if (event.shiftKey !== modifiers.includes("shift")) return false;
		const wantsMeta = modifiers.includes("meta");
		const wantsCtrl = modifiers.includes("ctrl");
		if (wantsMeta && wantsCtrl) return event.metaKey || event.ctrlKey;
		return wantsMeta ? event.metaKey && !event.ctrlKey : wantsCtrl && event.ctrlKey && !event.metaKey;
	});
}

/**
 * The shortcut the recent keys complete. A multi-key sequence such as `g i` matches when it ends the
 * buffer, so a stray key pressed just before it does not spoil it; a single key matches only when it is
 * the whole buffer, so the last key of an unfinished sequence does not trigger a one-key shortcut.
 */
export function findSequenceMatch(
	buffer: readonly string[],
	shortcuts: readonly ShortcutDefinition[],
): ShortcutDefinition | undefined {
	const last = buffer.length === 1 ? 1 : buffer.length - 1;
	for (let start = 0; start < last; start++) {
		const sequence = buffer.slice(start).join(" ");
		const match = shortcuts.find((shortcut) => shortcut.key.toLowerCase() === sequence);
		if (match) return match;
	}
	return undefined;
}
