"use client";

import { useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { BookingEvent } from "./types";

/**
 * Opens the event type a `/booking?event=<id>` link names once the list has loaded, then drops the
 * param so the same link works again. An id that is not in the list is ignored.
 */
export function useBookingEventFromUrl(events: BookingEvent[], loading: boolean, open: (event: BookingEvent) => void) {
	const router = useRouter();
	const id = useSearchParams().get("event");

	useEffect(() => {
		if (!id || loading) return;
		const event = events.find((item) => item.id === id);
		if (event) open(event);
		router.replace("/booking");
		// `open` changes on every render; only a new link or a finished load should act.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [id, loading, events]);
}
