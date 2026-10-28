"use client";

import { useMemo, type RefObject } from "react";
import { useHotkeys, useShortcuts, type ShortcutDefinition } from "@/components/shortcuts";
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
};

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
 * one), x selects it, and e and # archive or trash the selection, or the focused row when nothing is
 * selected.
 */
export function useMessageListKeyboard({
	listRef,
	folder,
	messageOpen,
	runOnRows,
	toggleRowSelection,
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
		const focusedId = () => focusedRow(listRef.current)?.dataset.messageRow ?? null;
		const handlers: Record<ListKeyId, () => void> = {
			next: () => move(1),
			previous: () => move(-1),
			open: () => rowLink(focusedRow(listRef.current) ?? undefined)?.click(),
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
	}, [folder, listRef, runOnRows, toggleRowSelection]);

	useHotkeys(shortcuts, { enabled: shortcutsEnabled && !messageOpen });
}
