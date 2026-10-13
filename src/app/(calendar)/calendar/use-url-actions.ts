"use client";

import { useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { calendarDateFromParam } from "./utils";

/**
 * Applies the links the palette builds: `/calendar?date=YYYY-MM-DD` shows that day, and
 * `/calendar?new=event` opens the new event dialog. The params are dropped afterwards so the same
 * command works again. An `event` param stays: the page opens that event once its day has loaded.
 * Returns whether such a link is still waiting to be applied: a series id resolves against the events loaded for that day.
 */
export function useCalendarUrlActions(show: (day: Date) => void, openNewEvent: (day?: Date) => void): boolean {
	const router = useRouter();
	const params = useSearchParams();
	const date = params.get("date");
	const create = params.get("new");
	const eventId = params.get("event");

	useEffect(() => {
		if (!date && create !== "event") return;
		const day = calendarDateFromParam(date);
		if (day) show(day);
		if (create === "event") openNewEvent(day ?? undefined);
		router.replace(eventId ? `/calendar?event=${encodeURIComponent(eventId)}` : "/calendar");
		// The callbacks change on every render; only a new link should act.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [date, create]);
	return Boolean(date || create);
}
