import { useCallback, useEffect, useRef, useState } from "react";
import { AUTH_SESSION_CHANGED_EVENT, authFetch } from "@/lib/auth/client";
import { AGENT_SUGGESTION_EVENT } from "./message-realtime-utils";

const REFRESH_DEBOUNCE_MS = 250;
/** Distinct URLs kept at most (the reader card asks per message or thread); the oldest go first. */
const MAX_ENTRIES = 50;

/**
 * One response per URL, shared by every component reading it, with the request in flight when there is one.
 * `dirty` asks for one more request once that one settles: a reload or an event that arrived while it ran may
 * not be reflected in its answer.
 */
type Entry = { data: unknown; inflight: Promise<void> | null; dirty: boolean; listeners: Set<() => void> };
const entries = new Map<string, Entry>();
/** Bumped on a sign-out or account switch, so a response of the previous session is thrown away. */
let session = 0;

function entryFor(url: string): Entry {
	let entry = entries.get(url);
	if (!entry) {
		entry = { data: undefined, inflight: null, dirty: false, listeners: new Set() };
		entries.set(url, entry);
		for (const key of entries.keys()) {
			if (entries.size <= MAX_ENTRIES) break;
			if (entries.get(key)!.listeners.size === 0) entries.delete(key);
		}
	}
	return entry;
}

/**
 * Fetches the URL once for everyone waiting on it; a failed fetch keeps the last response. `fresh` is for a
 * reload after a change and for events: a request already running may predate the change, so one more follows.
 */
function load(url: string, fresh = false): Promise<void> {
	const entry = entryFor(url);
	if (entry.inflight) {
		if (fresh) entry.dirty = true;
		return entry.inflight;
	}
	const started = session;
	entry.inflight = (async () => {
		try {
			const response = await authFetch(url);
			if (!response.ok || started !== session) return;
			entry.data = await response.json();
			if (started !== session) return;
			for (const listener of entry.listeners) listener();
		} catch {
			// Offline: the next event or reload tries again.
		} finally {
			entry.inflight = null;
			if (entry.dirty && started === session) {
				entry.dirty = false;
				void load(url);
			}
		}
	})();
	return entry.inflight;
}

/** A sign-out or account switch: nothing of the previous account may show, and its responses are dropped. */
function resetEntries() {
	session += 1;
	for (const entry of entries.values()) {
		entry.data = undefined;
		entry.dirty = false;
		for (const listener of entry.listeners) listener();
	}
	for (const [key, entry] of entries) if (entry.listeners.size === 0) entries.delete(key);
}
if (typeof window !== "undefined") window.addEventListener(AUTH_SESSION_CHANGED_EVENT, resetEntries);

/**
 * A suggestions API response, refetched whenever a suggestion or the mail changes. `data` is null until
 * the first response for the current URL arrives, so a list for a previous URL never shows. A failed
 * refresh keeps the last response. Readers of the same URL (the For you sidebar item, the For you page and the
 * empty reading pane, for instance) share one response and one request: a reader that mounts shows the last
 * response at once and refreshes it in the background, joining a request already in flight, and an event or a
 * `reload()` refreshes it once for all of them (once more after a request that was already running). A
 * sign-out or account switch clears everything.
 */
export function useSuggestionList<T>(url: string): { data: T | null; reload: () => void } {
	const [state, setState] = useState<{ url: string; data: T } | null>(null);
	const reloadRef = useRef<() => void>(() => undefined);

	useEffect(() => {
		const entry = entryFor(url);
		let timer: number | null = null;
		const sync = () => setState(entry.data === undefined ? null : { url, data: entry.data as T });
		const schedule = () => {
			if (timer) window.clearTimeout(timer);
			timer = window.setTimeout(() => void load(url, true), REFRESH_DEBOUNCE_MS);
		};

		entry.listeners.add(sync);
		reloadRef.current = () => void load(url, true);
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
