import type { LucideIcon } from "lucide-react";
import type { NavMode } from "@/components/settings/section-nav-types";

export type PageSearchResult = {
	/** Unique within one result list; used for the option element id. */
	id: string;
	href: string;
	label: string;
	icon: LucideIcon;
	mode: NavMode;
	/** The menu group heading, empty for a group without one. */
	section: string;
};

export type PageSearchGroup = {
	mode: NavMode;
	results: PageSearchResult[];
};
