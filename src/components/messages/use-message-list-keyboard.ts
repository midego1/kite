"use client";

import { useEffect, useMemo, type RefObject } from "react";
import { useHotkeys, useShortcuts, type ShortcutDefinition } from "@/components/shortcuts";
import { isTypingInInput } from "@/components/shortcuts/use-hotkeys";
import type { MessageFolder } from "@/hooks/types";
import { adjacentRowIndex, LIST_KEYS, type ListKeyId } from "./message-list-keyboard-utils";

type ListKeyboardOptions = {
	listRef: RefObject<HTMLElement | null>;
	folder: MessageFolder;
	/** An open message has its own keys (`message-shortcuts.ts`), so the list's stay quiet while one is open. */
	messageOpen: boolean;
	/** Archives or trashes the selection when there is one, else the focused row. */
	runOnRows: (action: "archive" | "trash", focusedId: string | null) => void;
	toggleRowSelection: (messageId: string) => void;
	/** Shift+Arrow: selects from the anchor (else the focused row) to `targetId`, the row the focus moved to. */
	extendSelection: (focusedId: string, targetId: string) => void;
	selectionCount: number;
	/** Escape empties the selection and nothing else: an open message stays open. */
	clearSelection: () => void;
	/** Cmd/Ctrl+A: selects every loaded row, the same as the list header's checkbox. */
	selectAllVisible: () => void;
	/** False while the list panel is hidden (the mobile reader): Cmd/Ctrl+A then belongs to whatever is on screen. */
	listVisible: boolean;
};

/**
 * Open popups: while one is on screen, Escape belongs to it, wherever the focus is. Hand-rolled menus have no
 * role of their own, so their trigger (`aria-haspopup`) says they are open; plain disclosure buttons, which are
 * expanded for good, do not count.
 */
const OPEN_POPUPS =
	'[role="dialog"], [role="alertdialog"], [aria-modal="true"], [role="menu"], [role="listbox"], [data-shortcuts-off], [aria-haspopup][aria-expanded="true"]';

/** The keys are the selection's when the focus is on the page itself or inside its list. */
function focusIsInList(list: HTMLElement | null): boolean {
	const active = document.activeElement;
	return !active || active === document.body || !!list?.contains(active);
}

/**
 * Whether a key belongs to the list's selection: no popup is open, the focus is not on text being typed, and
 * the target is the page itself (`body`/`documentElement`, nothing has taken the focus) or inside the folder
 * page's own area (its list and header carry `data-selection-scope`). Used only by Escape: with nothing
 * focused, Escape clearing a selection is the better default, and it is not a key the browser or page text
 * does anything else with.
 */
function isWithinSelectionScope(event: KeyboardEvent): boolean {
	if (isTypingInInput(event.target)) return false;
	if (document.querySelector(OPEN_POPUPS)) return false;
	const target = event.target;
	if (!(target instanceof HTMLElement) || target === document.body || target === document.documentElement) return true;
	return !!target.closest("[data-selection-scope]");
}

function escapeClearsSelection(event: KeyboardEvent): boolean {
	return event.key === "Escape" && isWithinSelectionScope(event);
}

/**
 * Whether Cmd/Ctrl+A belongs to the list: unlike Escape, a bare `body`/`documentElement` target does not count
 * here, since clicking plain text in the open message (which takes no focus of its own) would otherwise steal
 * the browser's own "select all page text" there. The target must be inside the folder page's own area.
 */
function isWithinListSelectionScope(event: KeyboardEvent): boolean {
	if (isTypingInInput(event.target)) return false;
	if (document.querySelector(OPEN_POPUPS)) return false;
	return event.target instanceof HTMLElement && !!event.target.closest("[data-selection-scope]");
}

/** Cmd (Apple) or Ctrl+A, unmodified otherwise so Shift/Alt combinations are left to the browser. */
function isSelectAllChord(event: KeyboardEvent): boolean {
	return (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "a";
}

function rows(list: HTMLElement | null): HTMLElement[] {
	return list ? Array.from(list.querySelectorAll<HTMLElement>("[data-message-row]")) : [];
}

function focusedRow(list: HTMLElement | null): HTMLElement | null {
	const active = document.activeElement;
	return active instanceof HTMLElement && list?.contains(active)
		? active.closest<HTMLElement>("[data-message-row]")
		: null;
}

function rowLink(row: HTMLElement | undefined): HTMLAnchorElement | null {
	return row?.querySelector<HTMLAnchorElement>("a[href]") ?? null;
}

/**
 * Gmail-style keys for a folder list: j and k move the focus between rows (Enter or o opens the focused
 * one), x selects it, Shift with the arrow keys extends the selection from its anchor, and e and # archive or trash the selection, or the focused row when nothing is
 * selected.
 */
export function useMessageListKeyboard({
	listRef,
	folder,
	messageOpen,
	runOnRows,
	toggleRowSelection,
	extendSelection,
	selectionCount,
	clearSelection,
	selectAllVisible,
	listVisible,
}: ListKeyboardOptions) {
	const { shortcutsEnabled } = useShortcuts();

	const shortcuts = useMemo<Array<ShortcutDefinition & { extend: boolean }>>(() => {
		const move = (step: 1 | -1) => {
			const all = rows(listRef.current);
			const current = focusedRow(listRef.current);
			const next = all[adjacentRowIndex(all.length, current ? all.indexOf(current) : -1, step)];
			const link = rowLink(next);
			link?.focus();
			link?.scrollIntoView({ block: "nearest" });
		};
		const extend = (step: 1 | -1) => {
			if (!focusIsInList(listRef.current)) return;
			const all = rows(listRef.current);
			const current = focusedRow(listRef.current);
			const next = all[adjacentRowIndex(all.length, current ? all.indexOf(current) : -1, step)];
			const nextId = next?.dataset.messageRow;
			if (!nextId) return;
			extendSelection(current?.dataset.messageRow ?? nextId, nextId);
			const link = rowLink(next);
			link?.focus();
			link?.scrollIntoView({ block: "nearest" });
		};
		const focusedId = () => focusedRow(listRef.current)?.dataset.messageRow ?? null;
		const handlers: Record<ListKeyId, () => void> = {
			next: () => move(1),
			previous: () => move(-1),
			open: () => rowLink(focusedRow(listRef.current) ?? undefined)?.click(),
			extendNext: () => extend(1),
			extendPrevious: () => extend(-1),
			select: () => {
				const id = focusedId();
				if (id) toggleRowSelection(id);
			},
			archive: () => {
				// Drafts never move to Archive; they are sent or deleted.
				if (folder !== "archived" && folder !== "drafts") runOnRows("archive", focusedId());
			},
			trash: () => {
				if (folder !== "trash") runOnRows("trash", focusedId());
			},
		};
		return LIST_KEYS.map(({ id, ...meta }) => ({ ...meta, action: handlers[id], extend: id.startsWith("extend") }));
	}, [folder, listRef, runOnRows, toggleRowSelection, extendSelection]);

	// With a selection the list is still what the user works with even while a message is open, so Shift+Arrow stays on.
	useHotkeys(
		shortcuts.filter((shortcut) => !shortcut.extend),
		{ enabled: shortcutsEnabled && !messageOpen },
	);
	useHotkeys(
		shortcuts.filter((shortcut) => shortcut.extend),
		{ enabled: shortcutsEnabled && (!messageOpen || selectionCount > 0) },
	);

	// Escape also works with a message open, where a selection takes the list over from the reader. Another
	// handler has already claimed the key by the time it bubbles (the global "dismiss" shortcut always does),
	// which is why this listens in the capture phase; Cmd/Ctrl+A needs the same priority over the browser's own
	// "select all page text".
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (selectionCount > 0 && escapeClearsSelection(event)) {
				clearSelection();
				return;
			}
			// Unlike Escape, Cmd/Ctrl+A is a shortcut like j/k/x/e/#, so it stays off with the rest of them, and with
			// the list itself: hidden (the mobile reader), it belongs to whatever is on screen instead.
			if (shortcutsEnabled && listVisible && isSelectAllChord(event) && isWithinListSelectionScope(event)) {
				event.preventDefault();
				selectAllVisible();
			}
		};
		window.addEventListener("keydown", onKeyDown, true);
		return () => window.removeEventListener("keydown", onKeyDown, true);
	}, [selectionCount, clearSelection, selectAllVisible, shortcutsEnabled, listVisible]);
}
