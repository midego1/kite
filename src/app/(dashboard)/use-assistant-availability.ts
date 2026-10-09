"use client";

import { useEffect, useLayoutEffect, useState } from "react";
import { AUTH_SESSION_CHANGED_EVENT, authFetch } from "@/lib/auth/client";
import { readInitialAssistantAvailability, saveAssistantAvailability } from "@/lib/agent/availability-client";
import type { AssistantAvailabilityResponse } from "./assistant-availability-types";

/** Admins rarely toggle the assistant, so focus refreshes are throttled to this interval. */
const FOCUS_REFRESH_INTERVAL_MS = 5 * 60_000;
let lastAvailabilityCheck = 0;

export function useAssistantAvailability() {
	const [enabled, setEnabled] = useState<boolean | null>(null);
	useLayoutEffect(() => {
		// The cached availability is only readable in the browser and must apply before paint.
		// eslint-disable-next-line react-hooks/set-state-in-effect
		setEnabled(readInitialAssistantAvailability());
	}, []);

	useEffect(() => {
		let active = true;
		const refresh = async () => {
			lastAvailabilityCheck = Date.now();
			try {
				const response = await authFetch("/api/agent/availability", { redirectOnUnauthorized: false });
				if (!response.ok) return;
				const data = (await response.json()) as AssistantAvailabilityResponse;
				if (active) {
					setEnabled(data.enabled);
					saveAssistantAvailability(data.enabled);
				}
			} catch {
				/* Availability can be refreshed when the window regains focus. */
			}
		};
		const refreshIfStale = () => {
			if (Date.now() - lastAvailabilityCheck >= FOCUS_REFRESH_INTERVAL_MS) void refresh();
		};
		const onFocus = () => refreshIfStale();
		const onSessionChanged = () => {
			void refresh();
		};
		const onVisibilityChange = () => {
			if (!document.hidden) refreshIfStale();
		};
		// The stored value renders immediately; a remount within the interval keeps it.
		if (lastAvailabilityCheck === 0) void refresh();
		else refreshIfStale();
		window.addEventListener("focus", onFocus);
		window.addEventListener(AUTH_SESSION_CHANGED_EVENT, onSessionChanged);
		document.addEventListener("visibilitychange", onVisibilityChange);
		return () => {
			active = false;
			window.removeEventListener("focus", onFocus);
			window.removeEventListener(AUTH_SESSION_CHANGED_EVENT, onSessionChanged);
			document.removeEventListener("visibilitychange", onVisibilityChange);
		};
	}, []);

	return enabled;
}
