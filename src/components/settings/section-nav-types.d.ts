import type { LucideIcon } from "lucide-react";
import type { ModuleId } from "@/lib/modules/module-types";

export type NavMode = "settings" | "admin";

/** `mailboxes` is the per-user mailbox grant, which members can hold too. */
export type NavPermission = "admin" | "primary" | "domains" | "users" | "mailboxes";

export type NavItem = {
	href: string;
	label: string;
	icon: LucideIcon;
	/** Extra words the menu search matches. */
	keywords?: string;
	permission?: NavPermission;
	/** Place among the module items of the same Settings group; core items default to Export's. */
	order?: number;
	/** Set on items a module contributes; they are hidden while that module is off for the user. */
	moduleId?: ModuleId;
};

export type NavSection = {
	/** Empty for a group without a visible heading; its landmark then uses `ariaLabel`. */
	label: string;
	ariaLabel?: string;
	items: NavItem[];
};

export type NavSearchGroup = {
	mode: NavMode;
	sections: NavSection[];
};
