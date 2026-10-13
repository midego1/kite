import type { ReactNode } from "react";
import { requireModulePage } from "@/lib/modules/route-guard";
import { CalendarShell } from "../(calendar)/calendar-shell";

// The module state decides what this layout renders, so it is never prerendered.
export const dynamic = "force-dynamic";

/**
 * Booking has its own route group so this guard runs above the shell: `AuthGuard` renders nothing on the server,
 * so a not-found thrown by a layout inside it reaches next build only after streaming starts, with status 200.
 */
export default async function BookingLayout({ children }: { children: ReactNode }) {
	await requireModulePage("booking");
	return <CalendarShell>{children}</CalendarShell>;
}
