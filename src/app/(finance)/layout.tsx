import type { ReactNode } from "react";
import { DashboardSectionShell } from "@/components/dashboard-section-shell";
import { requireModulePage } from "@/lib/modules/route-guard";

// The module state decides what this layout renders, so it is never prerendered.
export const dynamic = "force-dynamic";

/**
 * Money Watch has its own route group so this guard runs above the shell: `AuthGuard` renders nothing on the
 * server, so a not-found thrown by a layout inside it reaches next build only after streaming starts, with status 200.
 */
export default async function FinanceLayout({ children }: { children: ReactNode }) {
	await requireModulePage("finance");
	return <DashboardSectionShell>{children}</DashboardSectionShell>;
}
