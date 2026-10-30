// Mail folders and open messages are absent on purpose: useEmailPageTitle titles them with their counts.
const ROUTE_TITLES: ReadonlyArray<readonly [string, string]> = [
	["/settings", "Settings"],
	["/settings/account", "My account"],
	["/settings/appearance", "Appearance"],
	["/settings/inbox", "Inbox settings"],
	["/settings/composing", "Composing"],
	["/settings/notifications", "Notifications"],
	["/settings/rules", "Rules & routing"],
	["/settings/security", "Security"],
	["/settings/app-passwords", "App passwords"],
	["/settings/api-keys", "API keys"],
	["/settings/connected-accounts", "Connected accounts"],
	["/settings/export", "Export"],
	["/settings/import", "Import"],
	["/admin", "Admin overview"],
	["/domains", "Domains"],
	["/mailboxes", "Mailboxes"],
	["/routing", "Routing"],
	["/accounts", "Accounts"],
	["/modules", "Modules"],
	["/api-keys", "API keys"],
	["/webhooks", "Webhooks"],
	["/agent", "Agent"],
	["/agent/review", "AI draft review"],
	["/ai-usage", "AI usage"],
	["/general", "General"],
	["/branding", "Branding"],
	["/backups", "Backups"],
	["/alerts", "Alerts"],
	["/activity", "Activity"],
	["/calendar", "Calendar"],
	["/booking", "Bookings"],
	["/finance", "Subscriptions"],
	["/drive", "Drive"],
	["/drive/settings", "Drive settings"],
	["/compose", "Compose"],
	["/for-you", "For you"],
	["/kite-activity", "Activity"],
];

/** The page name for a signed-in route, from the most specific matching prefix, or null when the page titles itself. */
export function getRouteTitle(pathname: string): string | null {
	let best: readonly [string, string] | null = null;
	for (const entry of ROUTE_TITLES) {
		const [path] = entry;
		if (pathname !== path && !pathname.startsWith(`${path}/`)) continue;
		if (!best || path.length > best[0].length) best = entry;
	}
	return best ? best[1] : null;
}

export function formatRouteTitle(pageTitle: string, appName: string): string {
	return `${pageTitle} - ${appName}`;
}
