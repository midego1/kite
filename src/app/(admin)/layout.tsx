"use client";

import { usePathname } from "next/navigation";
import { requiresPrimaryAdmin } from "@/components/admin-route-utils";
import { DashboardSectionShell } from "@/components/dashboard-section-shell";
import { SectionLayout } from "@/components/settings/section-layout";
import { TelemetryNotice } from "@/components/telemetry/telemetry-notice";

export default function AdminLayout({ children }: { children: React.ReactNode }) {
	const pathname = usePathname();

	return (
		<DashboardSectionShell
			requireMailbox
			requireRole="admin"
			requirePrimary={requiresPrimaryAdmin(pathname)}
			// Admin shows the full notice above its pages, with the details and both choices; not also the short one.
			telemetryNotice="page"
		>
			<SectionLayout mode="admin">
				<TelemetryNotice variant="page" />
				{children}
			</SectionLayout>
		</DashboardSectionShell>
	);
}
