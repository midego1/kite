"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import { getMailboxAddress } from "@/components/mailbox-selector-utils";
import { queueLayoutSave } from "@/components/layout-preferences-client";
import type { LayoutLabelColor, LayoutLabelColors } from "@/lib/preferences/layout-types";
import {
	LABEL_COLORS_STORAGE_KEY,
	automaticMailboxColors,
	mailboxLabelColor,
	hasStaleLabelColors,
	parseStoredLabelColors,
	pruneLabelColors,
	withLabelColor,
} from "./label-colors-utils";
import { READING_LAYOUT_CHANGE_EVENT } from "./reading-layout-utils";

const NONE: LayoutLabelColors = {};
let cachedRaw: string | null | undefined;
let cached: LayoutLabelColors = NONE;

function readRaw(): string | null {
	try {
		return localStorage.getItem(LABEL_COLORS_STORAGE_KEY);
	} catch {
		return null;
	}
}

/** The stored colours, parsed once per stored text so every row reads the same object. */
function snapshot(): LayoutLabelColors {
	const raw = readRaw();
	if (raw !== cachedRaw) {
		cachedRaw = raw;
		cached = raw ? parseStoredLabelColors(raw) : NONE;
	}
	return cached;
}

function subscribe(onChange: () => void) {
	// The same events the reading layout uses: this tab's changes, and the account's layout once it is applied.
	window.addEventListener(READING_LAYOUT_CHANGE_EVENT, onChange);
	window.addEventListener("storage", onChange);
	return () => {
		window.removeEventListener(READING_LAYOUT_CHANGE_EVENT, onChange);
		window.removeEventListener("storage", onChange);
	};
}

/**
 * The colours chosen for the marks in the message list, by mailbox id and connected account id. Remembered in this
 * browser and saved to the account with the rest of the layout; every open list and sidebar follows a change.
 */
export function useLabelColors(): LayoutLabelColors {
	return useSyncExternalStore(subscribe, snapshot, () => NONE);
}

/**
 * The colour of a mailbox's dot: the one chosen for it, else an automatic one that differs from the automatic colours of
 * the user's other mailboxes (all of the mailboxes they can open, whichever are in view).
 */
export function useMailboxLabelColor() {
	const colors = useLabelColors();
	const { mailboxes } = useSelectedMailbox();
	const automatic = useMemo(
		() => automaticMailboxColors(mailboxes.map((mailbox) => ({ id: mailbox.id, address: getMailboxAddress(mailbox) }))),
		[mailboxes],
	);
	return useCallback(
		(mailbox: { id: string; address: string }) => mailboxLabelColor(colors, mailbox, automatic),
		[colors, automatic],
	);
}

function save(next: LayoutLabelColors) {
	try {
		localStorage.setItem(LABEL_COLORS_STORAGE_KEY, JSON.stringify(next));
	} catch {
		// Blocked storage: the choice still applies to the open pages until they close.
	}
	cachedRaw = undefined;
	window.dispatchEvent(new Event(READING_LAYOUT_CHANGE_EVENT));
	queueLayoutSave({ labelColors: next });
}

/**
 * Chooses a colour for a mailbox or an account, or `null` to go back to the automatic colour (mailbox) or the neutral
 * icon (account). Entries of mailboxes and accounts that are gone, as far as the caller knows them, are dropped.
 */
export function chooseLabelColor(
	kind: "mailboxes" | "accounts",
	id: string,
	color: LayoutLabelColor | null,
	known: { mailboxes?: readonly string[]; accounts?: readonly string[] } = {},
): void {
	save(pruneLabelColors(withLabelColor(snapshot(), kind, id, color), known));
}

/** Drops the entries of mailboxes and accounts that are gone; saves only when there is something to drop. */
export function pruneStoredLabelColors(known: { mailboxes?: readonly string[]; accounts?: readonly string[] }): void {
	const current = snapshot();
	if (hasStaleLabelColors(current, known)) save(pruneLabelColors(current, known));
}
