import type { ReactNode } from "react";
import { requireModulePage } from "@/lib/modules/route-guard";

// The module state decides what this layout renders, so it is never prerendered.
export const dynamic = "force-dynamic";

/**
 * Drive has its own route group so this guard runs above any client shell: a not-found thrown inside
 * `AuthGuard` would reach the response only after streaming starts, with status 200.
 */
export default async function DriveLayout({ children }: { children: ReactNode }) {
	await requireModulePage("drive");
	return children;
}
