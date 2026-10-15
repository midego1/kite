"use client";

import { useCallback, useEffect, useState } from "react";
import { authFetch } from "@/lib/auth/client";
import { getUserTimeZone } from "@/lib/time/utils";
import type { SubscriptionDetail, SubscriptionList } from "./subscriptions-types";

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

/** One subscription with its documents, reloaded whenever the list is. */
export function useSubscriptionDetail(id: string | null, version: number) {
	const [detail, setDetail] = useState<SubscriptionDetail | null>(null);
	const [missing, setMissing] = useState(false);

	useEffect(() => {
		if (!id) return;
		let live = true;
		authFetch(`/api/finance/subscriptions/${encodeURIComponent(id)}`, { cache: "no-store" })
			.then(async (response) => {
				if (!live) return;
				if (!response.ok) {
					setMissing(true);
					setDetail(null);
					return;
				}
				setMissing(false);
				setDetail((await response.json()) as SubscriptionDetail);
			})
			.catch(() => {
				if (live) setMissing(true);
			});
		return () => {
			live = false;
		};
	}, [id, version]);

	const current = detail && detail.subscription.id === id ? detail : null;
	return { detail: current, missing: id ? missing : false };
}
