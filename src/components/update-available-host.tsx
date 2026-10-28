"use client";

import { useEffect, useRef, useState } from "react";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import toast from "react-hot-toast";
import { TOAST_ACTION_CLASS } from "@/components/ui/toast-styles";
import { AUTH_ME_QUERY_KEY } from "@/lib/auth/me-client";
import type { AuthMeResponse } from "@/lib/auth/me-client-types";
import { STALE_ASSETS_EVENT, markAppReady } from "./asset-recovery-utils";
import {
	UPDATE_CHECK_INTERVAL_MS,
	UPDATE_TOAST_ID,
	UPDATE_TOAST_MESSAGE,
	compareDeploymentVersion,
	parseDeploymentVersion,
	shouldCheckForUpdate,
} from "./update-available-utils";

/**
 * Reads the session that the guards and pages already load rather than requesting
 * it, so public pages (sign-in, booking, shared Drive links) make no extra call.
 * It watches the cache itself because sign-in and account switches clear it.
 * Cache events also fire while other components render (a `useQuery` observer
 * attaching), so the state update waits for a microtask instead of running
 * inside their render.
 */
function readSessionUserId(client: QueryClient): string | null {
	return client.getQueryData<AuthMeResponse | null>(AUTH_ME_QUERY_KEY)?.user?.id ?? null;
}

function useSessionUserId(): string | null {
	const client = useQueryClient();
	const [userId, setUserId] = useState(() => readSessionUserId(client));

	useEffect(() => {
		let scheduled = false;
		const sync = () => {
			scheduled = false;
			setUserId(readSessionUserId(client));
		};
		const schedule = () => {
			if (scheduled) return;
			scheduled = true;
			queueMicrotask(sync);
		};
		schedule();
		return client.getQueryCache().subscribe(schedule);
	}, [client]);

	return userId;
}

function showUpdateAvailableToast() {
	toast(
		() => (
			<span className="flex items-center gap-3 text-sm">
				<span>{UPDATE_TOAST_MESSAGE}</span>
				<button type="button" className={TOAST_ACTION_CLASS} onClick={() => window.location.reload()}>
					Reload
				</button>
				<button
					type="button"
					aria-label="Dismiss"
					className="shrink-0 rounded-md p-1 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
					onClick={() => toast.dismiss(UPDATE_TOAST_ID)}
				>
					<X className="h-4 w-4" aria-hidden="true" />
				</button>
			</span>
		),
		{ id: UPDATE_TOAST_ID, duration: Infinity, ariaProps: { role: "status", "aria-live": "polite" } },
	);
}

/**
 * Tells a signed-in tab once that a newer deployment of this install is live.
 * It only compares the server's own version over time; nothing outside the
 * install is asked. A chunk that fails to load after the app has rendered
 * (see asset-recovery-utils.ts) checks at once instead of waiting for the next check.
 */
export function UpdateAvailableHost() {
	const userId = useSessionUserId();
	// The version belongs to the code this tab loaded, so it outlives sign-out and account switches.
	const knownVersion = useRef("");
	const shown = useRef(false);

	useEffect(() => {
		markAppReady();
	}, []);

	useEffect(() => {
		if (!userId) return;
		let lastCheckAt: number | null = null;
		let inFlight = false;
		let active = true;

		async function check() {
			if (shown.current) return;
			const now = Date.now();
			const visible = document.visibilityState === "visible";
			if (!shouldCheckForUpdate({ now, lastCheckAt, visible, inFlight })) return;
			lastCheckAt = now;
			inFlight = true;
			try {
				const response = await fetch("/api/version", { cache: "no-store" });
				if (!response.ok || !active) return;
				const decision = compareDeploymentVersion(knownVersion.current, parseDeploymentVersion(await response.json()));
				knownVersion.current = decision.known;
				if (decision.changed && active && !shown.current) {
					shown.current = true;
					showUpdateAvailableToast();
				}
			} catch {
				// Offline or mid-deploy: the next check tries again.
			} finally {
				inFlight = false;
			}
		}

		const onChange = () => void check();
		const onStaleAssets = () => {
			lastCheckAt = null;
			void check();
		};
		void check();
		const interval = window.setInterval(onChange, UPDATE_CHECK_INTERVAL_MS);
		window.addEventListener("focus", onChange);
		window.addEventListener(STALE_ASSETS_EVENT, onStaleAssets);
		document.addEventListener("visibilitychange", onChange);
		return () => {
			active = false;
			window.clearInterval(interval);
			window.removeEventListener("focus", onChange);
			window.removeEventListener(STALE_ASSETS_EVENT, onStaleAssets);
			document.removeEventListener("visibilitychange", onChange);
			if (shown.current) {
				// Hide on sign-out without allowing another notice in this tab.
				toast.dismiss(UPDATE_TOAST_ID);
			}
		};
	}, [userId]);

	return null;
}
