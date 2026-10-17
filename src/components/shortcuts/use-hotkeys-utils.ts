import type { ShortcutDefinition } from "./types";

const MODIFIER_KEYS = new Set(["shift", "control", "alt", "meta", "altgraph", "capslock", "os"]);

/** Pressing a modifier on its own (Shift before `!`, for example) is not a step of a key sequence. */
export function isModifierKey(key: string): boolean {
	return MODIFIER_KEYS.has(key.toLowerCase());
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
