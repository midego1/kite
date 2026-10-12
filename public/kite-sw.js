// Kite's notification service worker. It deliberately has no fetch handler:
// it exists only so new-mail notifications can carry a Copy code action and
// so clicking one copies a one-time code or opens the message, even when the
// tab that received the mail is closed. Served from the site root, so its
// scope is the whole origin.

self.addEventListener("install", () => {
	self.skipWaiting();
});

self.addEventListener("activate", (event) => {
	event.waitUntil(self.clients.claim());
});

self.addEventListener("notificationclick", (event) => {
	const data = event.notification.data || {};
	const code = typeof data.code === "string" ? data.code : null;
	const messageId = typeof data.messageId === "string" ? data.messageId : null;
	// Browsers without action buttons (Safari, Firefox on desktop) still get the
	// copy on a plain click, because copyOnClick is set for every code notification.
	const copyRequested = !!code && (event.action === "copy" || data.copyOnClick === true);
	event.notification.close();
	event.waitUntil(
		(async () => {
			const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
			let client = windows.find((entry) => entry.url.startsWith(self.registration.scope)) || null;
			if (client) {
				try {
					await client.focus();
				} catch {
					// Focus can be refused; still try to deliver the message.
				}
			} else {
				client = await self.clients.openWindow("/");
			}
			if (!client) return;
			if (copyRequested) client.postMessage({ type: "kite:copy-code", code });
			else if (messageId) client.postMessage({ type: "kite:open-message", messageId });
		})(),
	);
});
