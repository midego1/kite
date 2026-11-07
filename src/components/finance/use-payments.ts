"use client";

import { useCallback, useEffect, useState } from "react";
import { authFetch } from "@/lib/auth/client";
import type { PaymentList } from "./payments-types";

/** How often the list is read again while a scan runs. */
const SCAN_POLL_MS = 3_000;

/**
 * Every payment row and subscription document of the viewer; the view filters and totals them itself. While a scan
 * runs the list is read again every few seconds, so found payments appear as the scan goes.
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

	useEffect(() => {
		if (!scanning) return;
		const timer = window.setTimeout(reload, SCAN_POLL_MS);
		return () => window.clearTimeout(timer);
	}, [scanning, list, reload]);

	return { list, failed, reload };
}
