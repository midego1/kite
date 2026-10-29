"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState, type RefObject } from "react";
import { useCurrentUser } from "@/hooks/use-current-user";
import { authFetch } from "@/lib/auth/client";
import { telemetryStartDay } from "@/lib/telemetry/telemetry-utils";
import type { TelemetrySaveResult, TelemetryStatus } from "@/lib/telemetry/types";

/** One cache for the Admin → General card and the notice, so a choice made in one shows in the other. */
const TELEMETRY_STATUS_QUERY_KEY = ["admin", "telemetry"];

/** The id of the Admin → General card: the sidebar notice's Details link is `/general#usage-statistics`. */
export const TELEMETRY_CARD_ID = "usage-statistics";

export type TelemetryUpdate = { enabled: boolean } | { notice: "shown" | "dismissed" };

async function loadTelemetryStatus(): Promise<TelemetryStatus> {
	const response = await authFetch("/api/admin/telemetry", { cache: "no-store" });
	const data = (await response.json().catch(() => ({}))) as TelemetryStatus & { error?: string };
	if (!response.ok) throw new Error(data.error ?? "Could not load usage statistics");
	return data;
}

async function saveTelemetry(update: TelemetryUpdate): Promise<TelemetrySaveResult> {
	const response = await authFetch("/api/admin/telemetry", {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(update),
	});
	const data = (await response.json().catch(() => ({}))) as TelemetrySaveResult & { error?: string };
	if (!response.ok) throw new Error(data.error ?? "Could not save usage statistics");
	return data;
}

/** The owner's usage statistics status (`GET /api/admin/telemetry`) and the one way to change it. */
export function useTelemetryStatus() {
	const user = useCurrentUser();
	const owner = user?.role === "admin" && user.isPrimaryAdmin;
	const queryClient = useQueryClient();
	const query = useQuery({
		queryKey: TELEMETRY_STATUS_QUERY_KEY,
		queryFn: loadTelemetryStatus,
		enabled: owner,
		refetchOnWindowFocus: false,
		retry: false,
	});
	const save = useMutation({
		mutationFn: saveTelemetry,
		onSuccess: (status) => queryClient.setQueryData(TELEMETRY_STATUS_QUERY_KEY, status),
	});
	return { owner, query, save };
}

/**
 * The one-time notice of an install whose owner never chose. Until it has been seen it names the date the server
 * would store now (the same rule, `telemetryStartDay`), worked out when the notice becomes visible, never when the
 * page was opened: a tab left open since before 02:00 UTC must not name a time that has passed. `markShown`, called
 * once the notice is actually on screen, records that it was shown, which fixes that date, and from then on the
 * stored date is shown.
 */
export function useTelemetryNotice() {
	const { owner, query, save } = useTelemetryStatus();
	const [shownDay, setShownDay] = useState<string | null>(null);
	const status = query.data;
	const due = Boolean(owner && status?.notice);
	const unseen = due && !status?.startDay;
	const { mutate, isIdle } = save;
	const markShown = useCallback(() => {
		if (!unseen) return;
		setShownDay(telemetryStartDay(new Date()));
		if (isIdle) mutate({ notice: "shown" });
	}, [unseen, isIdle, mutate]);
	// Before it is visible nothing reads the date; the fallback only keeps the text from being empty.
	const startDay = due ? (status?.startDay ?? shownDay ?? telemetryStartDay(new Date())) : null;
	return { startDay, unseen, markShown, save, endpoint: status?.endpoint ?? null };
}

/**
 * Brings the card into view when the page was opened with its hash. The card is rendered only once the page's data is
 * there, after the browser already looked for the anchor, so it scrolls again when `ready`.
 */
export function useScrollToTelemetryCard(ready: boolean) {
	useEffect(() => {
		if (!ready || window.location.hash !== `#${TELEMETRY_CARD_ID}`) return;
		document.getElementById(TELEMETRY_CARD_ID)?.scrollIntoView({ block: "start" });
	}, [ready]);
}

/** Calls `onVisible` once the element is at least half on screen (not scrolled out of the notices box). */
export function useWhenVisible(ref: RefObject<HTMLElement | null>, active: boolean, onVisible: () => void) {
	useEffect(() => {
		const element = ref.current;
		if (!active || !element) return;
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((entry) => entry.isIntersecting)) onVisible();
			},
			{ threshold: 0.5 },
		);
		observer.observe(element);
		return () => observer.disconnect();
	}, [ref, active, onVisible]);
}
