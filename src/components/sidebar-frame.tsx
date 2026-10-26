"use client";

import type { ReactNode } from "react";
import { SidebarPanels } from "./sidebar-panels";
import { useSidebar } from "./sidebar-state";

/** The sidebar beside the page: resizable panels from `md` up, a sheet over the page on phones. */
export function SidebarFrame({ sidebar, children }: { sidebar: ReactNode; children: ReactNode }) {
	const { mobile } = useSidebar();
	if (!mobile) return <SidebarPanels sidebar={sidebar}>{children}</SidebarPanels>;
	return (
		<div className="flex h-full min-h-0">
			{sidebar}
			<div className="min-h-0 min-w-0 flex-1">{children}</div>
		</div>
	);
}
