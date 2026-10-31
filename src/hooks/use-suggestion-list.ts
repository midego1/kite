import { useCallback, useEffect, useRef, useState } from "react";
import { authFetch } from "@/lib/auth/client";
import { AGENT_SUGGESTION_EVENT } from "./message-realtime-utils";

const REFRESH_DEBOUNCE_MS = 250;
/** A list this fresh is shown as it is when another part of the page asks for the same URL. */
const FRESH_MS = 30_000;

/** One response per URL, shared by every component reading it, with the request in flight when there is one. */
type Entry = { data: unknown; at: number; inflight: Promise<void> | null; listeners: Set<() => void> };
const entries = new Map<string, Entry>();

function entryFor(url: string): Entry {
	let entry = entries.get(url);
	if (!entry) {
		entry = { data: undefined, at: 0, inflight: null, listeners: new Set() };
		entries.set(url, entry);
	}
	return entry;
}

/** Fetches the URL once for everyone waiting on it; a failed fetch keeps the last response. */
function load(url: string): Promise<void> {
	const entry = entryFor(url);
	if (entry.inflight) return entry.inflight;
	entry.inflight = (async () => {
		try {
			const response = await authFetch(url);
			if (!response.ok) return;
			entry.data = await response.json();
			entry.at = Date.now();
			for (const listener of entry.listeners) listener();
		} catch {
			// Offline: the next event or reload tries again.
		} finally {
			entry.inflight = null;
		}
	})();
	return entry.inflight;
}

/**
 * A suggestions API response, refetched whenever a suggestion or the mail changes. `data` is null until
 * the first response for the current URL arrives, so a list for a previous URL never shows. A failed
 * refresh keeps the last response. Readers of the same URL (the For you sidebar item and the empty reading
 * pane, for instance) share one response and one request: a reader that mounts while the response is fresh
 * shows it without fetching, and an event refreshes it once for all of them.
 */
export function useSuggestionList<T>(url: string): { data: T | null; reload: () => void } {
	const [state, setState] = useState<{ url: string; data: T } | null>(null);
	const reloadRef = useRef<() => void>(() => undefined);

	useEffect(() => {
		const entry = entryFor(url);
		let timer: number | null = null;
		const sync = () => {
			if (entry.data !== undefined) setState({ url, data: entry.data as T });
		};
		const schedule = () => {
			if (timer) window.clearTimeout(timer);
			timer = window.setTimeout(() => void load(url), REFRESH_DEBOUNCE_MS);
		};

		entry.listeners.add(sync);
		reloadRef.current = () => void load(url);
		if (entry.data === undefined || Date.now() - entry.at > FRESH_MS) void load(url);
		else sync();
		window.addEventListener(AGENT_SUGGESTION_EVENT, schedule);
		window.addEventListener("kite:messages-changed", schedule);
		return () => {
			entry.listeners.delete(sync);
			if (timer) window.clearTimeout(timer);
			window.removeEventListener(AGENT_SUGGESTION_EVENT, schedule);
			window.removeEventListener("kite:messages-changed", schedule);
		};
	}, [url]);

	const reload = useCallback(() => reloadRef.current(), []);
	return { data: state?.url === url ? state.data : null, reload };
}
