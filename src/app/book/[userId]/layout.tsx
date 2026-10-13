import type { ReactNode } from "react";
import { requirePublicModulePage } from "@/lib/modules/route-guard";

export const dynamic = "force-dynamic";

export default async function PublicBookingLayout({
	children,
	params,
}: {
	children: ReactNode;
	params: Promise<{ userId: string }>;
}) {
	await requirePublicModulePage("booking", { userId: (await params).userId });
	return children;
}
