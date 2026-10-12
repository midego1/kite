"use client";

import Link from "next/link";
import { CLIENT_MODULES } from "@/lib/modules/client-data";
import { moduleNavItems } from "@/lib/modules/nav-utils";
import type { ModuleNavPlacement } from "@/lib/modules/module-types";
import { resolveNavIcon } from "./client-registry";
import { useModules } from "./modules-context";

/** The account menu links that the modules on for this user contribute to `placement`. */
export function ModuleMenuLinks({ placement, onNavigate }: { placement: ModuleNavPlacement; onNavigate: () => void }) {
	const { modules } = useModules();
	return moduleNavItems(CLIENT_MODULES, placement, modules).map((item) => {
		const Icon = resolveNavIcon(item.icon);
		return (
			<Link
				key={item.id}
				href={item.href}
				onClick={onNavigate}
				className="mt-1 flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium text-neutral-700 hover:bg-[#f2f6fc]"
			>
				<Icon size={18} className="text-neutral-600" />
				{item.label}
			</Link>
		);
	});
}
