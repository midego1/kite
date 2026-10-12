"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
	areBrowserNotificationsEnabled,
	areOneTimeCodesInNotificationsEnabled,
	ensureNotificationServiceWorker,
	setBrowserNotificationsEnabled,
	setOneTimeCodesInNotificationsEnabled,
	showTestBrowserNotification,
} from "@/hooks/message-realtime-utils";

export function BrowserNotificationSettings() {
	const [permission, setPermission] = useState<NotificationPermission | "unsupported">("unsupported");
	const [enabled, setEnabled] = useState(false);
	const [codesEnabled, setCodesEnabled] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [testState, setTestState] = useState<"idle" | "sending" | "sent">("idle");

	useEffect(() => {
		const refresh = () => {
			setPermission(typeof Notification === "undefined" ? "unsupported" : Notification.permission);
			setEnabled(areBrowserNotificationsEnabled());
			setCodesEnabled(areOneTimeCodesInNotificationsEnabled());
		};
		refresh();
		window.addEventListener("focus", refresh);
		window.addEventListener("storage", refresh);
		return () => {
			window.removeEventListener("focus", refresh);
			window.removeEventListener("storage", refresh);
		};
	}, []);

	const notificationsReady = permission === "granted" && enabled;

	return (
		<div>
			<label className="flex items-start gap-3 rounded-xl bg-neutral-50 p-4">
				<span className="flex-1">
					<span className="block text-sm font-medium text-neutral-900">Browser notifications</span>
					<span className="mt-1 block text-sm text-neutral-500">
						Show a notification for new email while Kite is open in a background tab.
					</span>
				</span>
				<Switch
					checked={notificationsReady}
					disabled={permission === "unsupported" || permission === "denied"}
					onCheckedChange={(nextEnabled) => {
						setError(null);
						if (!nextEnabled) {
							try {
								setBrowserNotificationsEnabled(false);
								setEnabled(false);
							} catch {
								setError("Could not save the notification preference in this browser.");
							}
							return;
						}
						void (async () => {
							try {
								const nextPermission = permission === "granted" ? permission : await Notification.requestPermission();
								setPermission(nextPermission);
								if (nextPermission !== "granted") return;
								setBrowserNotificationsEnabled(true);
								setEnabled(true);
								// The Copy code action and click handling come from the service worker.
								await ensureNotificationServiceWorker();
							} catch {
								setError("Could not enable browser notifications.");
							}
						})();
					}}
					aria-label="Enable browser notifications"
				/>
			</label>
			<label className="mt-3 flex items-start gap-3 rounded-xl bg-neutral-50 p-4">
				<span className="flex-1">
					<span className="block text-sm font-medium text-neutral-900">Show one-time codes in notifications</span>
					<span className="mt-1 block text-sm text-neutral-500">
						When new mail contains a sign-in or verification code, put the code in the notification so one click copies
						it. Turn this off to keep codes out of the notification.
					</span>
				</span>
				<Switch
					checked={codesEnabled}
					disabled={!notificationsReady}
					onCheckedChange={(nextEnabled) => {
						setError(null);
						try {
							setOneTimeCodesInNotificationsEnabled(nextEnabled);
							setCodesEnabled(nextEnabled);
						} catch {
							setError("Could not save the one-time code preference in this browser.");
						}
					}}
					aria-label="Show one-time codes in notifications"
				/>
			</label>
			<div className="mt-3 flex flex-wrap items-center gap-3 px-4">
				<Button
					type="button"
					variant="outline"
					size="sm"
					disabled={!notificationsReady || testState === "sending"}
					onClick={() => {
						setError(null);
						setTestState("sending");
						void showTestBrowserNotification().then((shown) => {
							if (shown) {
								setTestState("sent");
								return;
							}
							setTestState("idle");
							setError(
								"Could not show a test notification. Check the browser's site settings and the system notification settings.",
							);
						});
					}}
				>
					Send test notification
				</Button>
				<span className="text-sm text-neutral-500" role="status">
					{testState === "sent"
						? "Test notification sent. If nothing appeared, check the system notification settings for this browser."
						: "Shows a sample notification to check that they appear on this device."}
				</span>
			</div>
			{permission === "denied" && (
				<p className="mt-2 px-4 text-sm text-neutral-500">
					Notifications are blocked. Allow them in your browser&apos;s site settings to enable this option.
				</p>
			)}
			{permission === "unsupported" && (
				<p className="mt-2 px-4 text-sm text-neutral-500">Browser notifications are unavailable here.</p>
			)}
			{error && <p className="mt-2 px-4 text-sm text-red-600">{error}</p>}
		</div>
	);
}
