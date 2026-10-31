import { useCallback, useEffect, useRef, useState } from "react";
import { authFetch } from "@/lib/auth/client";
import { AGENT_SUGGESTION_EVENT } from "./message-realtime-utils";

const REFRESH_DEBOUNCE_MS = 250;

/** One response per URL, shared by every component reading it, with the request in flight when there is one. */
type Entry = { data: unknown; inflight: Promise<void> | null; listeners: Set<() => void> };
const entries = new Map<string, Entry>();

function entryFor(url: string): Entry {
	let entry = entries.get(url);
	if (!entry) {
		entry = { data: undefined, inflight: null, listeners: new Set() };
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
 * refresh keeps the last response. Readers of the same URL (the For you sidebar item, the For you page and the
 * empty reading pane, for instance) share one response and one request: a reader that mounts shows the last
 * response at once and refreshes it in the background, joining a request already in flight, and an event
 * refreshes it once for all of them.
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
		sync();
		void load(url);
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
