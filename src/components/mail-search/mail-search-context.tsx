"use client";

import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { MailSearchContextValue } from "./types";

const MailSearchContext = createContext<MailSearchContextValue | null>(null);

export function useMailSearch() {
	const ctx = useContext(MailSearchContext);
	if (!ctx) throw new Error("useMailSearch must be used within MailSearchProvider");
	return ctx;
}

/** The mail search when there is one (inside the mail views), or null; for controls also shown elsewhere. */
export function useOptionalMailSearch() {
	return useContext(MailSearchContext);
}

const SEARCH_DEBOUNCE_MS = 250;

/** Where a search is left for the next mail view to pick up (the palette opens a contact's mail this way). */
const MAIL_SEARCH_HANDOFF_KEY = "kite:mail-search-handoff";
/** A note older than this is stale: the view it was meant for never mounted. */
const HANDOFF_MAX_AGE_MS = 10_000;

/** Leaves a search for the next mail view that mounts; nothing is left when storage is unavailable. */
export function handOffMailSearch(query: string): void {
	try {
		sessionStorage.setItem(MAIL_SEARCH_HANDOFF_KEY, JSON.stringify({ query, at: Date.now() }));
	} catch {
		// Private windows can refuse storage; the address still carries the search.
	}
}

function readHandoff(): string | null {
	try {
		const raw = sessionStorage.getItem(MAIL_SEARCH_HANDOFF_KEY);
		if (!raw) return null;
		const note = JSON.parse(raw) as { query?: unknown; at?: unknown };
		if (typeof note.query !== "string" || typeof note.at !== "number") return null;
		return Date.now() - note.at <= HANDOFF_MAX_AGE_MS ? note.query : null;
	} catch {
		return null;
	}
}

function clearHandoff(): void {
	try {
		sessionStorage.removeItem(MAIL_SEARCH_HANDOFF_KEY);
	} catch {
		// Nothing to clear without storage.
	}
}

/**
 * A search handed over to this view: a fresh note the palette left (the address bar still shows the old page
 * while the new one renders, so the note is what carries it), else `?q=` in the address (`/inbox?q=from:...`).
 * Reading only, so React may call it twice; the note is cleared once the view is mounted.
 */
function initialSearch(): string {
	if (typeof window === "undefined") return "";
	return readHandoff() ?? new URLSearchParams(window.location.search).get("q") ?? "";
}

export function MailSearchProvider({ children }: { children: ReactNode }) {
	// `input` follows every keystroke; `query` is what lists fetch with, and
	// trails it slightly so a typed word costs one request instead of one per letter.
	const [input, setInput] = useState(initialSearch);
	const [query, setQuery] = useState(input);

	useEffect(clearHandoff, []);

	useEffect(() => {
		// Clearing the box should empty the list at once; typing waits for a pause.
		const delay = input.trim() ? SEARCH_DEBOUNCE_MS : 0;
		const timer = setTimeout(() => setQuery(input.trim() ? input : ""), delay);
		return () => clearTimeout(timer);
	}, [input]);

	return (
		<MailSearchContext.Provider value={{ query, input, setQuery: setInput }}>{children}</MailSearchContext.Provider>
	);
}
