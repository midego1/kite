import type { ModuleId } from "@/lib/modules/module-types";

/** The destinations the phone tab bar can show; `more` opens the mail menu instead of a route. */
export type MobileTabId =
	"mail" | "for-you" | "calendar" | "drive" | "finance" | "starred" | "sent" | "drafts" | "more";

/** Mail links that the Mail tab covers when no more specific tab is on the bar. */
const MAIL_PREFIXES = [
	"/inbox",
	"/starred",
	"/snoozed",
	"/sent",
	"/drafts",
	"/archived",
	"/spam",
	"/trash",
	"/screener",
	"/for-you",
	"/folders",
	"/rules",
	"/import-export",
	"/kite-activity",
];

/** Module tabs in the order they fill the bar, most app-like first. */
const MODULE_TABS: readonly { id: MobileTabId; module: ModuleId }[] = [
	{ id: "calendar", module: "calendar" },
	{ id: "drive", module: "drive" },
	{ id: "finance", module: "finance" },
];

/** Core destinations that fill the bar when too few modules are on, so it never looks half empty. */
const FALLBACK_TABS: readonly MobileTabId[] = ["starred", "sent", "drafts"];

/** One tab plus More; five slots fit a phone at 320px. */
const MOBILE_TABBAR_PRIMARY_LIMIT = 4;

/**
 * The primary tabs before More: Mail first, then the modules that are on, then For you when it has
 * something to show, then core folders until the bar has four.
 */
export function mobilePrimaryTabIds(modules: readonly ModuleId[], forYouVisible: boolean): MobileTabId[] {
	const tabs: MobileTabId[] = ["mail"];
	for (const tab of MODULE_TABS) {
		if (modules.includes(tab.module)) tabs.push(tab.id);
	}
	if (forYouVisible && tabs.length < MOBILE_TABBAR_PRIMARY_LIMIT) tabs.push("for-you");
	for (const tab of FALLBACK_TABS) {
		if (tabs.length >= MOBILE_TABBAR_PRIMARY_LIMIT) break;
		tabs.push(tab);
	}
	return tabs.slice(0, MOBILE_TABBAR_PRIMARY_LIMIT);
}

/** Whether the path belongs to a tab's own area, ignoring the Mail tab's umbrella. */
function matchesOwnArea(tab: MobileTabId, pathname: string): boolean {
	switch (tab) {
		case "for-you":
			return pathname === "/for-you" || pathname.startsWith("/for-you/");
		case "calendar":
			return (
				pathname === "/calendar" ||
				pathname.startsWith("/calendar/") ||
				pathname === "/booking" ||
				pathname.startsWith("/booking/")
			);
		case "drive":
			return pathname === "/drive" || pathname.startsWith("/drive/");
		case "finance":
			return pathname === "/finance" || pathname.startsWith("/finance/");
		case "starred":
			return pathname === "/starred" || pathname.startsWith("/starred/");
		case "sent":
			return pathname === "/sent" || pathname.startsWith("/sent/");
		case "drafts":
			return pathname === "/drafts" || pathname.startsWith("/drafts/");
		default:
			return false;
	}
}

function isMailPath(pathname: string): boolean {
	return MAIL_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

/**
 * The one tab to mark current. A specific tab wins over Mail, so /starred is Starred when it is on the
 * bar and Mail when it is not; More is never current because it opens a sheet rather than a page.
 */
export function mobileActiveTabId(tabs: readonly MobileTabId[], pathname: string): MobileTabId | null {
	for (const tab of tabs) {
		if (tab === "mail" || tab === "more") continue;
		if (matchesOwnArea(tab, pathname)) return tab;
	}
	return tabs.includes("mail") && isMailPath(pathname) ? "mail" : null;
}

/**
 * A folder's message route (the reader) and the full-screen Compose page drop the bar: the reader keeps
 * its own Back button and reply bar, and the tab bar would only steal that room. With the list beside the
 * reader (`listBesideReader`) the message route keeps the bar, so it does not come and go as a message opens.
 */
export function hidesMobileTabBar(pathname: string, listBesideReader = false): boolean {
	if (pathname === "/compose" || pathname.startsWith("/compose/")) return true;
	if (listBesideReader) return false;
	if (/^\/(inbox|starred|snoozed|sent|drafts|archived|spam|trash|screener)\/[^/]+\/?$/.test(pathname)) return true;
	return /^\/folders\/[^/]+\/[^/]+\/?$/.test(pathname);
}
