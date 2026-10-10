import { useCallback, useEffect, useRef, useState } from "react";
import { authFetch } from "@/lib/auth/client";
import { AGENT_SUGGESTION_EVENT } from "./message-realtime-utils";
import type { OpenSuggestion, OpenSuggestionsState, SuggestionMailbox } from "./open-suggestions-types";

const REFRESH_DEBOUNCE_MS = 250;
const INITIAL: OpenSuggestionsState = { loaded: false, suggestions: [], mailboxes: [] };

/**
 * Open suggestions across the mailboxes where the user has full access, refreshed whenever a
 * suggestion or the mail changes. A failed refresh keeps the last list.
 */
export function useOpenSuggestions(): OpenSuggestionsState & { reload: () => void } {
	const [state, setState] = useState<OpenSuggestionsState>(INITIAL);
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
				const response = await authFetch("/api/agent/suggestions?status=open", { signal: current.signal });
				if (!response.ok) return;
				const data = (await response.json()) as { suggestions?: OpenSuggestion[]; mailboxes?: SuggestionMailbox[] };
				if (cancelled || current.signal.aborted) return;
				setState({ loaded: true, suggestions: data.suggestions ?? [], mailboxes: data.mailboxes ?? [] });
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
	}, []);

	const reload = useCallback(() => reloadRef.current(), []);
	return { ...state, reload };
}
