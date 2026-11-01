"use client";

import { useEffect, useState } from "react";
import type { ContactSearchHit } from "@/app/api/contacts/search/search-utils";
import { setMailboxScopeParam } from "@/hooks/utils";
import { authFetch } from "@/lib/auth/client";
import type { ModuleSearchSection } from "@/lib/search/module-search-types";
import { getUserTimeZone } from "@/lib/time/utils";
import type { PaletteMessageHit, PaletteRemoteResults } from "./palette-types";

const DEBOUNCE_MS = 200;
const MESSAGE_LIMIT = 8;
const CONTACT_LIMIT = 8;
const SECTION_LIMIT = 5;

type Answer = {
	query: string;
	messages: PaletteRemoteResults["messages"];
	contacts: PaletteRemoteResults["contacts"];
	sections: ModuleSearchSection[];
};

async function fetchJson<T>(url: string, signal: AbortSignal): Promise<T | null> {
	try {
		const response = await authFetch(url, { signal });
		return response.ok ? ((await response.json()) as T) : null;
	} catch {
		return null;
	}
}

async function fetchMessages(query: string, scope: string | null, signal: AbortSignal) {
	const params = new URLSearchParams({ q: query, limit: String(MESSAGE_LIMIT), timeZone: getUserTimeZone() });
	setMailboxScopeParam(params, scope);
	const data = await fetchJson<{ messages: PaletteMessageHit[]; total: number }>(`/api/messages?${params}`, signal);
	return data ? { items: data.messages, total: data.total ?? data.messages.length } : null;
}

async function fetchContacts(query: string, signal: AbortSignal) {
	const params = new URLSearchParams({ q: query, limit: String(CONTACT_LIMIT) });
	const data = await fetchJson<{ contacts: ContactSearchHit[]; total: number }>(
		`/api/contacts/search?${params}`,
		signal,
	);
	return data ? { items: data.contacts, total: data.total ?? data.contacts.length } : null;
}

async function fetchSections(query: string, signal: AbortSignal) {
	const params = new URLSearchParams({ q: query, limit: String(SECTION_LIMIT) });
	const data = await fetchJson<{ sections?: ModuleSearchSection[] }>(`/api/search?${params}`, signal);
	return data?.sections ?? [];
}

/**
 * Mail (in the current mailbox scope), contacts and module records for what the user is typing, after a
 * 200 ms pause. An answer is kept only for the text it was asked for, so a stale one never shows under
 * newer text, and a search that fails leaves its category empty while the others still answer.
 */
export function usePaletteSearch(input: string, mailboxScope: string | null): PaletteRemoteResults {
	const query = input.trim();
	const [answer, setAnswer] = useState<Answer | null>(null);

	useEffect(() => {
		if (!query) return;
		const controller = new AbortController();
		const timer = setTimeout(() => {
			void Promise.all([
				fetchMessages(query, mailboxScope, controller.signal),
				fetchContacts(query, controller.signal),
				fetchSections(query, controller.signal),
			]).then(([messages, contacts, sections]) => {
				if (!controller.signal.aborted) setAnswer({ query, messages, contacts, sections });
			});
		}, DEBOUNCE_MS);
		return () => {
			clearTimeout(timer);
			controller.abort();
		};
	}, [query, mailboxScope]);

	// The answer counts only for the text it was asked for; until it arrives the search is still running.
	const current = answer && answer.query === query ? answer : null;
	return {
		messages: current?.messages ?? null,
		contacts: current?.contacts ?? null,
		sections: current?.sections ?? [],
		loading: query !== "" && current === null,
	};
}
