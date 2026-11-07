"use client";

import { useCallback, useEffect, useState } from "react";
import { authFetch } from "@/lib/auth/client";
import type { PaymentList } from "./payments-types";

/** How often the list is read again while a scan runs. */
const SCAN_POLL_MS = 3_000;
/** How often an open Payments tab picks up payments recorded from new mail. */
const IDLE_POLL_MS = 60_000;

/**
 * Every payment row and subscription document of the viewer; the view filters them itself. The list is read again
 * every few seconds while a scan runs (also after a failed read), every minute otherwise while the tab is visible,
 * and when the window regains focus, so payments recorded from new mail appear without a reload.
 */
export function usePaymentList() {
	const [list, setList] = useState<PaymentList | null>(null);
	const [failed, setFailed] = useState(false);
	const [version, setVersion] = useState(0);
	const reload = useCallback(() => setVersion((current) => current + 1), []);
	const scanning = list?.scan?.status === "running";

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
				if (scanning || document.visibilityState === "visible") reload();
			},
			scanning ? SCAN_POLL_MS : IDLE_POLL_MS,
		);
		return () => window.clearTimeout(timer);
	}, [scanning, version, reload]);

	useEffect(() => {
		window.addEventListener("focus", reload);
		return () => window.removeEventListener("focus", reload);
	}, [reload]);

	return { list, failed, reload };
}
