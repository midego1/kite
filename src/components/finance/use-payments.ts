"use client";

import { useCallback, useEffect, useState } from "react";
import type { ModuleNoticeEvent } from "@/hooks/message-realtime-types";
import { MODULE_NOTICE_EVENT } from "@/hooks/message-realtime-utils";
import { authFetch } from "@/lib/auth/client";
import type { PaymentList } from "./payments-types";

/** How often the list is read again while a scan runs. */
const SCAN_POLL_MS = 3_000;
/** How often an open Payments tab picks up payments recorded from new mail. */
const IDLE_POLL_MS = 60_000;

/**
 * Every payment row and subscription document of the viewer; the view filters them itself. The list is read again
 * every few seconds while a scan runs, every minute otherwise, and when the window regains focus or the tab becomes
 * visible again, so payments recorded from new mail appear without a reload; either interval only fires while the
 * tab is visible, so a background tab never polls. A failed read (Money Watch turned off while a scan looked to be
 * running included) stops the fast interval at once instead of trusting the last list's stale `scan` status.
 */
export function usePaymentList() {
	const [list, setList] = useState<PaymentList | null>(null);
	const [failed, setFailed] = useState(false);
	const [version, setVersion] = useState(0);
	const reload = useCallback(() => setVersion((current) => current + 1), []);
	const scanning = !failed && list?.scan?.status === "running";

	useEffect(() => {
		let live = true;
		authFetch("/api/finance/payments", { cache: "no-store" })
			.then(async (response) => {
				if (!response.ok) throw new Error();
				const data = (await response.json()) as PaymentList;
				if (live) {
					setList(data);
					setFailed(false);
				}
			})
			.catch(() => {
				if (live) setFailed(true);
			});
		return () => {
			live = false;
		};
	}, [version]);

	// Keyed on `version`, so the next read is scheduled after every attempt, a failed one included.
	useEffect(() => {
		const timer = window.setTimeout(
			() => {
				if (document.visibilityState === "visible") reload();
			},
			scanning ? SCAN_POLL_MS : IDLE_POLL_MS,
		);
		return () => window.clearTimeout(timer);
	}, [scanning, version, reload]);

	useEffect(() => {
		window.addEventListener("focus", reload);
		return () => window.removeEventListener("focus", reload);
	}, [reload]);

	// A tab switch (or returning from the phone's app switcher) is a visibility change, not necessarily a window
	// focus event, and the poll above only reschedules itself after a read: catch up at once instead of waiting out
	// however much of the last, skipped interval was left when the tab went to the background.
	useEffect(() => {
		function onVisible() {
			if (document.visibilityState === "visible") reload();
		}
		document.addEventListener("visibilitychange", onVisible);
		return () => document.removeEventListener("visibilitychange", onVisible);
	}, [reload]);

	// A finished scan's realtime notice reaches every open tab, including one the owner left and came back to.
	useEffect(() => {
		function onNotice(event: Event) {
			if ((event as CustomEvent<ModuleNoticeEvent>).detail?.moduleId === "finance") reload();
		}
		window.addEventListener(MODULE_NOTICE_EVENT, onNotice);
		return () => window.removeEventListener(MODULE_NOTICE_EVENT, onNotice);
	}, [reload]);

	return { list, failed, reload };
}
