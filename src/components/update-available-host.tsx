"use client";

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import toast from "react-hot-toast";
import { TOAST_ACTION_CLASS } from "@/components/ui/toast-styles";
import { useSessionUserId } from "@/hooks/use-session-user-id";
import { STALE_ASSETS_EVENT, markAppReady, takeStaleAssetsSignal } from "./asset-recovery-utils";
import { ReloadFlight } from "./reload-flight";
import {
	UPDATE_CHECK_INTERVAL_MS,
	UPDATE_TOAST_ID,
	UPDATE_TOAST_MESSAGE,
	compareDeploymentVersion,
	parseDeploymentVersion,
	shouldCheckForUpdate,
} from "./update-available-utils";

function showUpdateAvailableToast(onReload: () => void) {
	toast(
		() => (
			<span className="flex items-center gap-3 text-sm">
				<span>{UPDATE_TOAST_MESSAGE}</span>
				<button type="button" className={TOAST_ACTION_CLASS} onClick={onReload}>
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
 * (see asset-recovery-utils.ts) checks at once instead of waiting for the next check. Reload plays the kite's
 * flight (reload-flight.tsx) and then reloads; the flight exists only for this reload to a new version.
 */
export function UpdateAvailableHost() {
	const userId = useSessionUserId();
	// The version belongs to the code this tab loaded, so it outlives sign-out and account switches.
	const knownVersion = useRef("");
	const shown = useRef(false);
	const [reloading, setReloading] = useState(false);

	useEffect(() => {
		// The first client commit has happened; see ASSET_RECOVERY_READY_FLAG for what that does and does not mean.
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
					showUpdateAvailableToast(() => {
						toast.dismiss(UPDATE_TOAST_ID);
						setReloading(true);
					});
				}
			} catch {
				// Offline or mid-deploy: the next check tries again.
			} finally {
				inFlight = false;
			}
		}

		const onChange = () => void check();
		const onStaleAssets = () => {
			takeStaleAssetsSignal();
			lastCheckAt = null;
			void check();
		};
		// A chunk may have failed before the session was known and this listener existed.
		if (takeStaleAssetsSignal()) onStaleAssets();
		else void check();
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

	return <ReloadFlight active={reloading} />;
}
