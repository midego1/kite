import type { ReactNode } from "react";
import { requireModulePage } from "@/lib/modules/route-guard";

export const dynamic = "force-dynamic";

export default async function BookingLayout({ children }: { children: ReactNode }) {
	await requireModulePage("booking", "calendar");
	return children;
}
