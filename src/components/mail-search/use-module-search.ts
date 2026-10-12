"use client";

import { useEffect, useState } from "react";
import { authFetch } from "@/lib/auth/client";
import type { ModuleSearchSection } from "@/lib/search/module-search-types";

const MODULE_SEARCH_DEBOUNCE_MS = 200;
const MODULE_SEARCH_LIMIT = 5;

type Answer = { query: string; sections: ModuleSearchSection[] };

/**
 * The module sections (Events and so on) for what the user is typing, after a 200 ms pause. Sections
 * come back only for the text they answered, so a stale answer never shows under newer text. A failed
 * request shows nothing; mail search is unaffected.
 */
export function useModuleSearch(input: string): ModuleSearchSection[] {
	const [answer, setAnswer] = useState<Answer | null>(null);
	const query = input.trim();

	useEffect(() => {
		if (!query) return;
		const controller = new AbortController();
		const timer = setTimeout(() => {
			void authFetch(`/api/search?q=${encodeURIComponent(query)}&limit=${MODULE_SEARCH_LIMIT}`, {
				signal: controller.signal,
			})
				.then((response) => (response.ok ? (response.json() as Promise<{ sections?: ModuleSearchSection[] }>) : null))
				.then((data) => setAnswer({ query, sections: data?.sections ?? [] }))
				.catch(() => undefined);
		}, MODULE_SEARCH_DEBOUNCE_MS);
		return () => {
			clearTimeout(timer);
			controller.abort();
		};
	}, [query]);

	return answer && answer.query === query ? answer.sections : [];
}
