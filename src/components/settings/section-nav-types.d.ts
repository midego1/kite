import type { LucideIcon } from "lucide-react";

export type NavMode = "settings" | "admin";

export type NavPermission = "admin" | "primary" | "domains" | "users";

export type NavItem = {
	href: string;
	label: string;
	icon: LucideIcon;
	/** Extra words the menu search matches. */
	keywords?: string;
	permission?: NavPermission;
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
