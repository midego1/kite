"use client";

import { useEffect } from "react";
import { useSessionUserId } from "@/hooks/use-session-user-id";
import { flushLayoutSave, startLayoutSync, stopLayoutSync } from "./layout-preferences-client";

/** Coming back to a tab picks up layout changes made on another device, at most once a minute. */
const REFRESH_AFTER_MS = 60_000;

/**
 * Keeps this browser's layout in step with the account's (`layout-preferences-client.ts`). It reads the
 * session the pages already load, so public pages make no extra request.
 */
export function LayoutPreferencesSync() {
	const userId = useSessionUserId();

	useEffect(() => {
		if (!userId) return;
		let loadedAt = Date.now();
		void startLayoutSync(userId);
		const onVisibilityChange = () => {
			if (document.visibilityState === "hidden") {
				void flushLayoutSave();
				return;
			}
			if (Date.now() - loadedAt < REFRESH_AFTER_MS) return;
			loadedAt = Date.now();
			void startLayoutSync(userId);
		};
		const onPageHide = () => void flushLayoutSave();
		document.addEventListener("visibilitychange", onVisibilityChange);
		window.addEventListener("pagehide", onPageHide);
		return () => {
			document.removeEventListener("visibilitychange", onVisibilityChange);
			window.removeEventListener("pagehide", onPageHide);
			// Not flushed: after an account switch the cookie already names the next account.
			stopLayoutSync();
		};
	}, [userId]);

	return null;
}
