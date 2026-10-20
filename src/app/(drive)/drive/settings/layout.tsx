import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { DashboardSectionShell } from "@/components/dashboard-section-shell";
import { SectionLayout } from "@/components/settings/section-layout";
import { isAdmin } from "@/lib/auth/admin";
import { getCurrentUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";

// Members get the not-found page, as for a page that does not exist; signed-out visitors go to the login.
export default async function DriveSettingsLayout({ children }: { children: ReactNode }) {
	const user = await getCurrentUser(getEnv());
	if (user && !isAdmin(user)) notFound();
	return (
		<DashboardSectionShell requireMailbox requireRole="admin">
			<SectionLayout mode="admin">{children}</SectionLayout>
		</DashboardSectionShell>
	);
}
