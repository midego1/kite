import { useCallback, useEffect, useRef, useState } from "react";
import { authFetch } from "@/lib/auth/client";
import { AGENT_SUGGESTION_EVENT } from "./message-realtime-utils";

const REFRESH_DEBOUNCE_MS = 250;

/**
 * A suggestions API response, refetched whenever a suggestion or the mail changes. `data` is null until
 * the first response for the current URL arrives, so a list for a previous URL never shows. A failed
 * refresh keeps the last response.
 */
export function useSuggestionList<T>(url: string): { data: T | null; reload: () => void } {
	const [state, setState] = useState<{ url: string; data: T } | null>(null);
	const reloadRef = useRef<() => void>(() => undefined);

	useEffect(() => {
		let cancelled = false;
		let timer: number | null = null;
		let controller: AbortController | null = null;

		async function load() {
			controller?.abort();
			const current = new AbortController();
			controller = current;
			try {
				const response = await authFetch(url, { signal: current.signal });
				if (!response.ok) return;
				const data = (await response.json()) as T;
				if (!cancelled && !current.signal.aborted) setState({ url, data });
			} catch {
				// Aborted or offline: the next event or reload tries again.
			}
		}

		function schedule() {
			if (timer) window.clearTimeout(timer);
			timer = window.setTimeout(() => void load(), REFRESH_DEBOUNCE_MS);
		}

		reloadRef.current = () => void load();
		void load();
		window.addEventListener(AGENT_SUGGESTION_EVENT, schedule);
		window.addEventListener("kite:messages-changed", schedule);
		return () => {
			cancelled = true;
			controller?.abort();
			if (timer) window.clearTimeout(timer);
			window.removeEventListener(AGENT_SUGGESTION_EVENT, schedule);
			window.removeEventListener("kite:messages-changed", schedule);
		};
	}, [url]);

	const reload = useCallback(() => reloadRef.current(), []);
	return { data: state?.url === url ? state.data : null, reload };
}
