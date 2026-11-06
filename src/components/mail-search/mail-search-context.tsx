"use client";

import { usePathname } from "next/navigation";
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useKeyChanged } from "@/hooks/use-synced-state";
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
/** The address parameter that opens an account's view (`/inbox?via=<address>`). */
const VIEW_PARAM = "via";

type Handoff = { query: string; view: string | null };

/** Leaves a search (and an account view) for the next mail view that mounts; nothing is left when storage is unavailable. */
export function handOffMailSearch(query: string, view: string | null = null): void {
	try {
		sessionStorage.setItem(MAIL_SEARCH_HANDOFF_KEY, JSON.stringify({ query, view, at: Date.now() }));
	} catch {
		// Private windows can refuse storage; the address still carries the search.
	}
}

function readHandoff(): Handoff | null {
	try {
		const raw = sessionStorage.getItem(MAIL_SEARCH_HANDOFF_KEY);
		if (!raw) return null;
		const note = JSON.parse(raw) as { query?: unknown; view?: unknown; at?: unknown };
		if (typeof note.query !== "string" || typeof note.at !== "number") return null;
		if (Date.now() - note.at > HANDOFF_MAX_AGE_MS) return null;
		return { query: note.query, view: typeof note.view === "string" && note.view ? note.view : null };
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
 * A search handed over to this view: a fresh note the palette or an account view left (the address bar still shows
 * the old page while the new one renders, so the note is what carries it), else `?q=` and `?via=` in the address
 * (`/inbox?q=from:...`). Reading only, so React may call it twice; the note is cleared once the view is mounted.
 */
function initialSearch(): Handoff {
	if (typeof window === "undefined") return { query: "", view: null };
	const note = readHandoff();
	if (note) return note;
	const params = new URLSearchParams(window.location.search);
	return { query: params.get("q") ?? "", view: params.get(VIEW_PARAM) || null };
}

/** Takes the account view out of the address, so a reload of the page does not open it again. */
function dropViewFromAddress(): void {
	try {
		const url = new URL(window.location.href);
		if (!url.searchParams.has(VIEW_PARAM)) return;
		url.searchParams.delete(VIEW_PARAM);
		window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
	} catch {
		// The address stays as it was.
	}
}

export function MailSearchProvider({ children }: { children: ReactNode }) {
	const [initial] = useState(initialSearch);
	// `input` follows every keystroke; `query` is what lists fetch with, and
	// trails it slightly so a typed word costs one request instead of one per letter.
	const [input, setInput] = useState(initial.query);
	const [typed, setTyped] = useState(initial.query);
	const [view, setViewState] = useState<string | null>(initial.view);
	const pathname = usePathname();

	useEffect(clearHandoff, []);

	useEffect(() => {
		// Clearing the box should empty the list at once; typing waits for a pause.
		const delay = input.trim() ? SEARCH_DEBOUNCE_MS : 0;
		const timer = setTimeout(() => setTyped(input.trim() ? input : ""), delay);
		return () => clearTimeout(timer);
	}, [input]);

	// A view belongs to the mail pages: leaving them closes it, so no hidden filter follows to Settings or the calendar.
	if (useKeyChanged(pathname) && !isMailPath(pathname) && view) setViewState(null);

	const value = useMemo<MailSearchContextValue>(
		() => ({
			query: [view ? `via:${view}` : "", typed].filter(Boolean).join(" "),
			input,
			setQuery: setInput,
			view,
			setView: (address) => {
				setViewState(address || null);
				if (!address) dropViewFromAddress();
			},
		}),
		[view, typed, input],
	);

	return <MailSearchContext.Provider value={value}>{children}</MailSearchContext.Provider>;
}

const MAIL_FOLDER_PREFIXES = [
	"/inbox",
	"/starred",
	"/snoozed",
	"/sent",
	"/drafts",
	"/archived",
	"/spam",
	"/trash",
	"/folders",
];

/** The mail lists and the open message, where a view narrows the list. */
function isMailPath(pathname: string): boolean {
	return MAIL_FOLDER_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}
