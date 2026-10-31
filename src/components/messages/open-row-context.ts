"use client";

import { createContext, useCallback, useContext, useRef, useState } from "react";

/** Finds the ids the list row holding a message stands for, or null when no loaded row holds it. */
export type RowMessageIdsLookup = (messageId: string) => string[] | null;

/** Filled in by the split layout from its list, so the reader acts on what the open message's row stands for. */
export const OpenRowContext = createContext<RowMessageIdsLookup | null>(null);

/**
 * The ids a move from the reader acts on: everything the open message's row stands for in the list (its
 * conversation within the list's filter, in conversation view), else the message alone.
 */
export function useRowMessageIds(): (messageId: string) => string[] {
	const lookup = useContext(OpenRowContext);
	return useCallback((messageId: string) => lookup?.(messageId) ?? [messageId], [lookup]);
}

/**
 * The split layout's end: `register` is handed to the list, `lookup` (stable) goes into `OpenRowContext` and asks
 * whatever the list registered last.
 */
export function useRowLookupHolder() {
	const current = useRef<RowMessageIdsLookup | null>(null);
	const [lookup] = useState<RowMessageIdsLookup>(() => (messageId: string) => current.current?.(messageId) ?? null);
	const [register] = useState(() => (next: RowMessageIdsLookup | null) => {
		current.current = next;
	});
	return { lookup, register };
}
