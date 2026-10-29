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
	/** Escape clears the selection. */
	clearSelection: () => void;
};

/** Where Escape belongs to something else: a dialog, a menu, a listbox or an area that owns its keys. */
const ESCAPE_OWNERS =
	'[role="dialog"], [role="alertdialog"], [aria-modal="true"], [role="menu"], [role="listbox"], [data-shortcuts-off]';

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
}: ListKeyboardOptions) {
	const { shortcutsEnabled } = useShortcuts();

	const shortcuts = useMemo<ShortcutDefinition[]>(() => {
		const move = (step: 1 | -1) => {
			const all = rows(listRef.current);
			const current = focusedRow(listRef.current);
			const next = all[adjacentRowIndex(all.length, current ? all.indexOf(current) : -1, step)];
			const link = rowLink(next);
			link?.focus();
			link?.scrollIntoView({ block: "nearest" });
		};
		const extend = (step: 1 | -1) => {
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
		return LIST_KEYS.map(({ id, ...meta }) => ({ ...meta, action: handlers[id] }));
	}, [folder, listRef, runOnRows, toggleRowSelection, extendSelection]);

	useHotkeys(shortcuts, { enabled: shortcutsEnabled && !messageOpen });

	// Escape also works with a message open, where a selection replaces the reading pane.
	useEffect(() => {
		if (selectionCount === 0) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || isTypingInInput(event.target)) return;
			if (event.target instanceof HTMLElement && event.target.closest(ESCAPE_OWNERS)) return;
			clearSelection();
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [selectionCount, clearSelection]);
}
