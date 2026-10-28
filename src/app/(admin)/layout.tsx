"use client";

import { usePathname } from "next/navigation";
import { requiresPrimaryAdmin } from "@/components/admin-route-utils";
import { DashboardSectionShell } from "@/components/dashboard-section-shell";
import { SectionLayout } from "@/components/settings/section-layout";
import { TelemetryNotice, TelemetryNoticeOnPage } from "@/components/telemetry/telemetry-notice";

export default function AdminLayout({ children }: { children: React.ReactNode }) {
	const pathname = usePathname();

	return (
		// The notice is told above the admin pages, so the sidebar's copy steps aside here.
		<TelemetryNoticeOnPage.Provider value>
			<DashboardSectionShell requireMailbox requireRole="admin" requirePrimary={requiresPrimaryAdmin(pathname)}>
				<SectionLayout mode="admin">
					<TelemetryNotice variant="page" />
					{children}
				</SectionLayout>
			</DashboardSectionShell>
		</TelemetryNoticeOnPage.Provider>
	);
}
