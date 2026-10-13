import type { ReactNode } from "react";
import { DashboardSectionShell } from "@/components/dashboard-section-shell";
import { SectionLayout } from "@/components/settings/section-layout";
import { requireModulePage } from "@/lib/modules/route-guard";

export const dynamic = "force-dynamic";

/**
 * Import has its own route group so this guard runs above the settings shell: `AuthGuard` renders nothing on the
 * server, so a not-found thrown by a layout inside it reaches next build only after streaming starts, with status 200.
 */
export default async function ImportLayout({ children }: { children: ReactNode }) {
	await requireModulePage("import");
	return (
		<DashboardSectionShell>
			<SectionLayout mode="settings">{children}</SectionLayout>
		</DashboardSectionShell>
	);
}
