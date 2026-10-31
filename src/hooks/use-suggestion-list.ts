import { useCallback, useEffect, useRef, useState } from "react";
import { AUTH_SESSION_CHANGED_EVENT, authFetch } from "@/lib/auth/client";
import { AGENT_SUGGESTION_EVENT } from "./message-realtime-utils";
import { createSuggestionListStore } from "./suggestion-list-store";

const store = createSuggestionListStore((url) => authFetch(url), {
	setTimeout: (callback, ms) => window.setTimeout(callback, ms),
	clearTimeout: (handle) => window.clearTimeout(handle as number),
});
if (typeof window !== "undefined") {
	window.addEventListener(AUTH_SESSION_CHANGED_EVENT, store.reset);
	window.addEventListener(AGENT_SUGGESTION_EVENT, store.scheduleRefresh);
	window.addEventListener("kite:messages-changed", store.scheduleRefresh);
}

/**
 * A suggestions API response, refetched whenever a suggestion or the mail changes. `data` is null until
 * the first response for the current URL arrives, so a list for a previous URL never shows. A failed
 * refresh keeps the last response. Readers of the same URL (the For you sidebar item, the For you page and the
 * empty reading pane, for instance) share one response, one request and one refresh timer
 * (`suggestion-list-store.ts`): a reader that mounts shows the last response at once and refreshes it in the
 * background, joining a request already in flight, and an event or a `reload()` refreshes it once for all of them
 * (once more after a request that was already running). A sign-out or account switch clears everything.
 */
export function useSuggestionList<T>(url: string): { data: T | null; reload: () => void } {
	const [state, setState] = useState<{ url: string; data: T } | null>(null);
	const reloadRef = useRef<() => void>(() => undefined);

	useEffect(() => {
		const sync = () => {
			const data = store.read(url);
			setState(data === undefined ? null : { url, data: data as T });
		};
		const unsubscribe = store.subscribe(url, sync);
		reloadRef.current = () => void store.load(url, true);
		sync();
		void store.load(url);
		return unsubscribe;
	}, [url]);

	const reload = useCallback(() => reloadRef.current(), []);
	return { data: state?.url === url ? state.data : null, reload };
}
