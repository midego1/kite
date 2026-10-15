"use client";

import { CLIENT_MODULES } from "@/lib/modules/client-data";
import { moduleNavItems } from "@/lib/modules/nav-utils";
import type { NavLink } from "../components-nav-types";
import { resolveNavIcon } from "./client-registry";
import { useModules } from "./modules-context";
import { useModuleNavCounts } from "./use-module-nav-counts";

const FOR_YOU_HREF = "/for-you";

/** The `sidebar` nav items of the modules on for this user, with their counts, placed under For you. */
export function useModuleSidebarLinks() {
	const { modules } = useModules();
	const items = moduleNavItems(CLIENT_MODULES, "sidebar", modules);
	const counts = useModuleNavCounts(items);
	const links = items.map((item): NavLink => ({
		href: item.href,
		label: item.label,
		icon: resolveNavIcon(item.icon),
		count: counts[item.id],
	}));
	return {
		after(main: NavLink[]): NavLink[] {
			if (links.length === 0) return main;
			const anchor = main.findIndex((link) => link.href === FOR_YOU_HREF);
			const at = anchor >= 0 ? anchor + 1 : main.findIndex((link) => link.href === "/inbox") + 1;
			return [...main.slice(0, at), ...links, ...main.slice(at)];
		},
	};
}
