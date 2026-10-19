/** The part of `navigator` the Badging API adds; both methods are missing where it is unsupported. */
export type AppBadgeNavigator = {
	setAppBadge?: (contents?: number) => Promise<void>;
	clearAppBadge?: () => Promise<void>;
};

export function supportsAppBadge(nav: AppBadgeNavigator | undefined | null): nav is Required<AppBadgeNavigator> {
	return !!nav && typeof nav.setAppBadge === "function" && typeof nav.clearAppBadge === "function";
}

/** A whole, non-negative unread count; anything else counts as nothing unread. */
function appBadgeCount(unread: unknown): number {
	if (typeof unread !== "number" || !Number.isFinite(unread) || unread <= 0) return 0;
	return Math.floor(unread);
}

type InboxCounts = { folders: { inbox: { unread: number } } };

/**
 * The Inbox unread count to show, or null while it is not known yet. `placeholder` is the object
 * the counts hook returns before its first answer and after a failed one; mirroring it would clear
 * a badge that still holds the last real count.
 */
export function knownInboxUnread(counts: InboxCounts, placeholder: InboxCounts, isLoading: boolean): number | null {
	if (isLoading || counts === placeholder) return null;
	return appBadgeCount(counts.folders.inbox.unread);
}

/**
 * Shows `count` on the installed app's icon, or clears it at zero. Browsers reject outside an
 * installed app (and some throw synchronously); the badge is cosmetic, so every failure is ignored.
 */
export async function applyAppBadge(nav: AppBadgeNavigator | undefined | null, count: unknown): Promise<void> {
	if (!supportsAppBadge(nav)) return;
	const badge = appBadgeCount(count);
	try {
		await (badge > 0 ? nav.setAppBadge(badge) : nav.clearAppBadge());
	} catch {
		// Ignored: see above.
	}
}

export function clearAppBadge(nav: AppBadgeNavigator | undefined | null): Promise<void> {
	return applyAppBadge(nav, 0);
}
