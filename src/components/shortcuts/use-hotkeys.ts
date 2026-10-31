"use client";

import { useEffect, useRef } from "react";
import type { ShortcutDefinition } from "./types";
import { findChordMatch, findSequenceMatch, isBrowserChord, isModifierKey } from "./use-hotkeys-utils";

/** Where bare-key shortcuts never fire; mark other areas that own their keys with `data-shortcuts-off`. */
const SHORTCUT_FREE_ZONES =
	'[role="dialog"], [role="alertdialog"], [aria-modal="true"], [role="menu"], [role="listbox"], [data-shortcuts-off]';

interface UseHotkeysOptions {
	enabled?: boolean;
}

export function isTypingInInput(target: EventTarget | null): boolean {
	if (!target || !(target instanceof HTMLElement)) return false;
	const tagName = target.tagName.toUpperCase();
	const isInputOrTextarea = tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT";
	const isContentEditable = target.isContentEditable || target.getAttribute("contenteditable") === "true";
	// A Select trigger is a button with role="combobox" that types ahead through its options, as a native
	// select does, so its keys belong to it.
	const isCombobox = target.getAttribute("role") === "combobox";
	return isInputOrTextarea || isContentEditable || isCombobox;
}

function matchModifiers(e: KeyboardEvent, shortcut: ShortcutDefinition): boolean {
	const requiresCtrl = shortcut.modifiers?.includes("ctrl");
	const requiresMeta = shortcut.modifiers?.includes("meta");
	const requiresAlt = shortcut.modifiers?.includes("alt");
	const requiresShift = shortcut.modifiers?.includes("shift");

	const hasCtrl = e.ctrlKey;
	const hasMeta = e.metaKey;
	const hasAlt = e.altKey;
	const hasShift = e.shiftKey;

	if (requiresCtrl && requiresMeta) {
		if (!hasCtrl && !hasMeta) return false;
	} else if (requiresCtrl && !hasCtrl) {
		return false;
	} else if (requiresMeta && !hasMeta) {
		return false;
	}

	if (requiresAlt && !hasAlt) return false;
	if (requiresShift && !hasShift) return false;

	if (!requiresCtrl && !requiresMeta && (hasCtrl || hasMeta)) return false;
	if (!requiresAlt && hasAlt) return false;

	return true;
}

export function useHotkeys(shortcuts: ShortcutDefinition[], options: UseHotkeysOptions = { enabled: true }) {
	const sequenceBufferRef = useRef<string[]>([]);
	const sequenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const shortcutsRef = useRef<ShortcutDefinition[]>(shortcuts);

	useEffect(() => {
		shortcutsRef.current = shortcuts;
	}, [shortcuts]);

	useEffect(() => {
		if (options.enabled === false) return;

		const handleKeyDown = (e: KeyboardEvent) => {
			const isInput = isTypingInInput(e.target);
			const key = e.key.toLowerCase();

			// Always allow Cmd+K / Ctrl+K
			if ((e.metaKey || e.ctrlKey) && key === "k") {
				const cmdK = shortcutsRef.current.find(
					(s) => s.key.toLowerCase() === "k" && (s.modifiers?.includes("meta") || s.modifiers?.includes("ctrl")),
				);
				if (cmdK) {
					e.preventDefault();
					cmdK.action();
					return;
				}
			}

			if (isInput) {
				if (e.key === "Escape") {
					const esc = shortcutsRef.current.find(
						(s) => s.key.toLowerCase() === "escape" || s.key.toLowerCase() === "esc",
					);
					if (esc) esc.action();
				}
				return;
			}

			if (isModifierKey(key)) return;

			// Sequences match on bare keys, so the `g` of Cmd+G must not start `g i`.
			if (isBrowserChord(e)) {
				sequenceBufferRef.current = [];
				if (sequenceTimerRef.current) {
					clearTimeout(sequenceTimerRef.current);
					sequenceTimerRef.current = null;
				}
				// A page may claim a Cmd/Ctrl chord outright (the reader's Cmd/Ctrl+P), outside dialogs and menus.
				const chord = findChordMatch(e, shortcutsRef.current);
				if (chord && !(e.target instanceof HTMLElement && e.target.closest(SHORTCUT_FREE_ZONES))) {
					e.preventDefault();
					chord.action();
				}
				return;
			}

			// Bare keys inside a dialog, menu, listbox or the composer belong to it: `e` on a focused button there
			// must not archive the message behind it.
			if (e.target instanceof HTMLElement && e.target.closest(SHORTCUT_FREE_ZONES)) return;

			// Handle sequence buffer
			sequenceBufferRef.current.push(key);

			if (sequenceTimerRef.current) {
				clearTimeout(sequenceTimerRef.current);
			}

			sequenceTimerRef.current = setTimeout(() => {
				sequenceBufferRef.current = [];
			}, 800);

			const sequenceMatch = findSequenceMatch(sequenceBufferRef.current, shortcutsRef.current);

			if (sequenceMatch && matchModifiers(e, sequenceMatch)) {
				e.preventDefault();
				sequenceBufferRef.current = [];
				sequenceMatch.action();
				return;
			}

			const singleMatch = shortcutsRef.current.find((s) => {
				if (s.key === "?" && e.key === "?") return true;
				if (s.key === "/" && e.key === "/") return true;
				if (s.key === "#" && e.key === "#") return true;

				if (s.key.toLowerCase() !== key) return false;
				return matchModifiers(e, s);
			});

			if (singleMatch) {
				e.preventDefault();
				sequenceBufferRef.current = [];
				singleMatch.action();
			}
		};

		window.addEventListener("keydown", handleKeyDown);
		return () => {
			window.removeEventListener("keydown", handleKeyDown);
			if (sequenceTimerRef.current) {
				clearTimeout(sequenceTimerRef.current);
			}
		};
	}, [options.enabled]);
}
