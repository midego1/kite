"use client";

import { useMemo, type RefObject } from "react";
import { useHotkeys, useShortcuts, type ShortcutDefinition } from "@/components/shortcuts";
import type { MessageFolder } from "@/hooks/types";
import { adjacentRowIndex } from "./message-list-keyboard-utils";

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
		return [
			{ key: "j", label: "Next email", category: "Navigation", action: () => move(1) },
			{ key: "k", label: "Previous email", category: "Navigation", action: () => move(-1) },
			{
				key: "o",
				label: "Open email",
				category: "Navigation",
				action: () => rowLink(focusedRow(listRef.current) ?? undefined)?.click(),
			},
			{
				key: "x",
				label: "Select email",
				category: "Selection",
				action: () => {
					const id = focusedId();
					if (id) toggleRowSelection(id);
				},
			},
			{
				key: "e",
				label: "Archive",
				category: "Actions",
				action: () => {
					if (folder !== "archived") runOnRows("archive", focusedId());
				},
			},
			{
				key: "#",
				label: "Move to Trash",
				category: "Actions",
				action: () => {
					if (folder !== "trash") runOnRows("trash", focusedId());
				},
			},
		];
	}, [folder, listRef, runOnRows, toggleRowSelection]);

	useHotkeys(shortcuts, { enabled: shortcutsEnabled && !messageOpen });
}
