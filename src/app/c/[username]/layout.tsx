import type { ReactNode } from "react";
import { requirePublicModulePage } from "@/lib/modules/route-guard";

export const dynamic = "force-dynamic";

export default async function PublicBookingUsernameLayout({
	children,
	params,
}: {
	children: ReactNode;
	params: Promise<{ username: string }>;
}) {
	await requirePublicModulePage("booking", { username: (await params).username });
	return children;
}
