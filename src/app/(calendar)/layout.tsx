import type { ReactNode } from "react";
import { requireModulePage } from "@/lib/modules/route-guard";
import { CalendarShell } from "./calendar-shell";

// The module state decides what this layout renders, so it is never prerendered.
export const dynamic = "force-dynamic";

export default async function CalendarLayout({ children }: { children: ReactNode }) {
	await requireModulePage("calendar");
	return <CalendarShell>{children}</CalendarShell>;
}
