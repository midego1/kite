/** Events within this window refresh a URL once. */
export const SUGGESTION_REFRESH_DEBOUNCE_MS = 250;
/** Distinct URLs kept at most (the reader card asks per message or thread); the oldest go first. */
const MAX_ENTRIES = 50;

/**
 * One response per URL, shared by every component reading it, with the request in flight when there is one.
 * `dirty` asks for one more request once that one settles: a reload or an event that arrived while it ran may
 * not be reflected in its answer. `timer` is the URL's one pending refresh after events, whoever reads it.
 */
type Entry = {
	data: unknown;
	inflight: Promise<void> | null;
	dirty: boolean;
	timer: unknown;
	listeners: Set<() => void>;
};

export interface SuggestionListTimers {
	setTimeout(callback: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

/**
 * The store behind `useSuggestionList`, with the fetch and the timers injected so it can be tested. Every reader of
 * a URL shares its response, its request and its refresh timer.
 */
export function createSuggestionListStore(fetchList: (url: string) => Promise<Response>, timers: SuggestionListTimers) {
	const entries = new Map<string, Entry>();
	/** Bumped on a sign-out or account switch, so a response of the previous session is thrown away. */
	let session = 0;

	function clearTimer(entry: Entry) {
		if (entry.timer !== null) timers.clearTimeout(entry.timer);
		entry.timer = null;
	}

	function entryFor(url: string): Entry {
		let entry = entries.get(url);
		if (!entry) {
			entry = { data: undefined, inflight: null, dirty: false, timer: null, listeners: new Set() };
			entries.set(url, entry);
			for (const [key, old] of entries) {
				if (entries.size <= MAX_ENTRIES) break;
				if (old.listeners.size > 0) continue;
				clearTimer(old);
				entries.delete(key);
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
				const response = await fetchList(url);
				if (!response.ok || started !== session) return;
				const data: unknown = await response.json();
				if (started !== session) return;
				entry.data = data;
				for (const listener of entry.listeners) listener();
			} catch {
				// Offline: the next event or reload tries again.
			} finally {
				// After a reset the entry belongs to the next session, which may have a request of its own by now.
				if (started === session) {
					entry.inflight = null;
					if (entry.dirty) {
						entry.dirty = false;
						void load(url);
					}
				}
			}
		})();
		return entry.inflight;
	}

	/** Adds a reader of the URL; returns its removal. */
	function subscribe(url: string, listener: () => void): () => void {
		const entry = entryFor(url);
		entry.listeners.add(listener);
		return () => {
			entry.listeners.delete(listener);
		};
	}

	/** The last response for the URL, or undefined before the first one of this session. */
	function read(url: string): unknown {
		return entries.get(url)?.data;
	}

	/** A suggestion or the mail changed: every URL someone is reading refreshes once, shortly after the last event. */
	function scheduleRefresh() {
		for (const [url, entry] of entries) {
			if (entry.listeners.size === 0) continue;
			clearTimer(entry);
			entry.timer = timers.setTimeout(() => {
				entry.timer = null;
				if (entry.listeners.size > 0) void load(url, true);
			}, SUGGESTION_REFRESH_DEBOUNCE_MS);
		}
	}

	/**
	 * A sign-out or account switch: nothing of the previous account may show, its responses are dropped, and its
	 * requests are forgotten, so a reader mounting right after the switch starts a request of its own instead of
	 * joining one whose answer will be thrown away.
	 */
	function reset() {
		session += 1;
		for (const entry of entries.values()) {
			entry.data = undefined;
			entry.dirty = false;
			entry.inflight = null;
			clearTimer(entry);
			for (const listener of entry.listeners) listener();
		}
		for (const [key, entry] of entries) if (entry.listeners.size === 0) entries.delete(key);
	}

	return { load, subscribe, read, scheduleRefresh, reset };
}
