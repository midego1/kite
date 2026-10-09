"use client";

import { usePathname } from "next/navigation";
import { requiresPrimaryAdmin } from "@/components/admin-route-utils";
import { DashboardSectionShell } from "@/components/dashboard-section-shell";
import { SectionLayout } from "@/components/settings/section-layout";

export default function AdminLayout({ children }: { children: React.ReactNode }) {
	const pathname = usePathname();

	return (
		<DashboardSectionShell requireMailbox requireRole="admin" requirePrimary={requiresPrimaryAdmin(pathname)}>
			<SectionLayout mode="admin">{children}</SectionLayout>
		</DashboardSectionShell>
	);
}
