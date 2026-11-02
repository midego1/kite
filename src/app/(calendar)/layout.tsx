import type { ReactNode } from "react";
import { requireModulePage } from "@/lib/modules/route-guard";
import { DashboardShell } from "../(dashboard)/dashboard-shell";

// The module state decides what this layout renders, so it is never prerendered.
export const dynamic = "force-dynamic";

/**
 * Calendar has its own route group so this guard runs above the shell: `AuthGuard` renders nothing on the
 * server, so a not-found thrown by a layout inside it would reach the response after streaming starts, with
 * status 200. The page itself sits in the mail shell, like every other page.
 */
export default async function CalendarLayout({ children }: { children: ReactNode }) {
	await requireModulePage("calendar");
	return <DashboardShell>{children}</DashboardShell>;
}
