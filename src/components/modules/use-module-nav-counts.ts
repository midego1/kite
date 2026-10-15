"use client";

import { useEffect, useState } from "react";
import { AGENT_SUGGESTION_EVENT, MODULE_NOTICE_EVENT } from "@/hooks/message-realtime-utils";
import { authFetch } from "@/lib/auth/client";
import type { ModuleNavEntry } from "@/lib/modules/nav-utils";

const COUNT_REFRESH_MS = 5 * 60_000;
const REFRESH_DEBOUNCE_MS = 250;

/**
 * The counts of module nav items that declare a count endpoint, by item id. Each endpoint answers
 * `{ count }`; it is fetched on load, every five minutes, on window focus, and when a module notice or
 * a suggestion change arrives. A failed fetch keeps the last count.
 */
export function useModuleNavCounts(items: readonly ModuleNavEntry[]): Record<string, number> {
	const [counts, setCounts] = useState<Record<string, number>>({});
	const sources = items.flatMap((item) => (item.count ? [`${item.id} ${item.count.endpoint}`] : []));
	const key = sources.join("\n");

	useEffect(() => {
		const targets = key ? key.split("\n").map((line) => line.split(" ") as [string, string]) : [];
		if (targets.length === 0) return;
		let cancelled = false;
		let timer: number | null = null;
		const controller = new AbortController();

		async function loadOne(id: string, endpoint: string) {
			try {
				const response = await authFetch(endpoint, { signal: controller.signal });
				if (!response.ok) return;
				const data = (await response.json()) as { count?: unknown };
				if (cancelled || typeof data.count !== "number") return;
				const count = data.count;
				setCounts((current) => (current[id] === count ? current : { ...current, [id]: count }));
			} catch {
				// Aborted or offline: the next refresh tries again.
			}
		}

		const load = () => void Promise.all(targets.map(([id, endpoint]) => loadOne(id, endpoint)));
		function schedule() {
			if (timer) window.clearTimeout(timer);
			timer = window.setTimeout(load, REFRESH_DEBOUNCE_MS);
		}

		load();
		const interval = window.setInterval(load, COUNT_REFRESH_MS);
		window.addEventListener("focus", schedule);
		window.addEventListener(MODULE_NOTICE_EVENT, schedule);
		window.addEventListener(AGENT_SUGGESTION_EVENT, schedule);
		return () => {
			cancelled = true;
			controller.abort();
			if (timer) window.clearTimeout(timer);
			window.clearInterval(interval);
			window.removeEventListener("focus", schedule);
			window.removeEventListener(MODULE_NOTICE_EVENT, schedule);
			window.removeEventListener(AGENT_SUGGESTION_EVENT, schedule);
		};
	}, [key]);

	return counts;
}
