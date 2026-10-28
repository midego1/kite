"use client";

import { AlertsBanner } from "./alerts-banner";
import { DnsSkippedBanner } from "./dns-skipped-banner";
import { MigrationsBanner } from "./migrations-banner";
import { useSidebar } from "./sidebar-state";
import { TelemetryNotice } from "./telemetry/telemetry-notice";

/**
 * The operational and setup notices, rendered once: above Settings in the expanded sidebar, or over the page
 * on phones and while the sidebar is the icon rail, where they would not fit. In the sidebar they scroll past a
 * third of the window, so they never squeeze the menu.
 */
export function DashboardNotices({ slot }: { slot: "sidebar" | "page" }) {
	const { mobile, minimal } = useSidebar();
	const inSidebar = !mobile && !minimal;
	if ((slot === "sidebar") !== inSidebar) return null;
	return (
		<div
			className={
				slot === "sidebar"
					? "mb-2 flex max-h-[35vh] flex-col gap-2 overflow-y-auto empty:hidden"
					: "flex flex-col gap-2 px-2 pb-2 empty:hidden"
			}
		>
			<TelemetryNotice variant="sidebar" />
			<AlertsBanner />
			<MigrationsBanner />
			<DnsSkippedBanner />
		</div>
	);
}
