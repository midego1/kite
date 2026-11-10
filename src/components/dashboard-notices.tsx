"use client";

import { AlertsBanner } from "./alerts-banner";
import { ConnectedAccountsBanner } from "./connected-accounts-banner";
import { DnsSkippedBanner } from "./dns-skipped-banner";
import { MigrationsBanner } from "./migrations-banner";
import { useSidebar } from "./sidebar-state";

/**
 * The operational and setup notices, rendered once: above Settings in the expanded sidebar, or over the page
 * on phones and while the sidebar is the icon rail, where they would not fit. The sidebar's footer already scrolls
 * past 45% of its height, so the notices have no scroller of their own: a second one only produced scrollbars inside
 * the cards. The usage statistics notice is not one of them: it is drawn above the Admin pages only.
 */
export function DashboardNotices({ slot }: { slot: "sidebar" | "page" }) {
	const { mobile, minimal } = useSidebar();
	const inSidebar = !mobile && !minimal;
	if ((slot === "sidebar") !== inSidebar) return null;
	return (
		<div
			className={
				slot === "sidebar"
					? "mb-2 flex min-w-0 flex-col gap-2 empty:hidden"
					: "flex flex-col gap-2 px-2 pb-2 empty:hidden"
			}
		>
			<AlertsBanner />
			<MigrationsBanner />
			<DnsSkippedBanner />
			<ConnectedAccountsBanner />
		</div>
	);
}
