"use client";

import { useCallback, useEffect, useState } from "react";
import { authFetch } from "@/lib/auth/client";
import { getUserTimeZone } from "@/lib/time/utils";
import type {
	DrawerState,
	SubscriptionDetail,
	SubscriptionDetailPending,
	SubscriptionList,
} from "./subscriptions-types";
import { drawerState } from "./subscriptions-utils";

type DetailAnswer = SubscriptionDetail | SubscriptionDetailPending | "missing";

/** The viewer's calendar day in their time zone, as the server's totals and badge count it. */
export function viewerToday(): string {
	return new Date().toLocaleDateString("en-CA", { timeZone: getUserTimeZone() });
}

export function viewerLocale(): string {
	return typeof navigator === "undefined" ? "en" : navigator.language || "en";
}

/**
 * Every subscription of the viewer with the totals; the view filters by status itself so the totals
 * and the "without a price" count always cover every row. `version` changes after each write.
 */
export function useSubscriptionList() {
	const [list, setList] = useState<SubscriptionList | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [version, setVersion] = useState(0);
	const reload = useCallback(() => setVersion((current) => current + 1), []);

	useEffect(() => {
		let live = true;
		authFetch("/api/finance/subscriptions?status=all", { cache: "no-store" })
			.then(async (response) => {
				if (!response.ok) throw new Error();
				const data = (await response.json()) as SubscriptionList;
				if (live) {
					setList(data);
					setError(null);
				}
			})
			.catch(() => {
				if (live) setError("Could not load your subscriptions.");
			});
		return () => {
			live = false;
		};
	}, [version]);

	return { list, error, version, reload };
}

/**
 * The drawer state for one subscription with its documents, reloaded whenever the list is. An answer
 * counts only for the id it was fetched for, so switching rows shows Loading instead of the last row.
 */
export function useSubscriptionDetail(id: string | null, version: number): DrawerState {
	const [answer, setAnswer] = useState<{ id: string; body: DetailAnswer } | null>(null);

	useEffect(() => {
		if (!id) return;
		let live = true;
		authFetch(`/api/finance/subscriptions/${encodeURIComponent(id)}`, { cache: "no-store" })
			.then(async (response) => {
				const body: DetailAnswer = response.ok ? ((await response.json()) as DetailAnswer) : "missing";
				if (live) setAnswer({ id, body });
			})
			.catch(() => {
				if (live) setAnswer({ id, body: "missing" });
			});
		return () => {
			live = false;
		};
	}, [id, version]);

	return drawerState(id, answer && answer.id === id ? answer.body : null);
}
