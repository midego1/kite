import type { ReactNode } from "react";
import { requireModulePage } from "@/lib/modules/route-guard";

export const dynamic = "force-dynamic";

export default async function ImportLayout({ children }: { children: ReactNode }) {
	await requireModulePage("import");
	return children;
}
