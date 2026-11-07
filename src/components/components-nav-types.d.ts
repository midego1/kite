import type { LucideIcon } from "lucide-react";

export type NavLink = {
	href?: string;
	label?: string;
	icon?: LucideIcon;
	iconColor?: string;
	/** The icon colour in the collapsed rail, where an icon with none stays as neutral as the system folders. */
	railIconColor?: string;
	primary?: boolean;
	preloadMessages?: boolean;
	count?: number;
	/** The row's tooltip. */
	title?: string;
	/** Overrides the highlight, which otherwise follows the route (a link with a search in its address needs it). */
	active?: boolean;
	/** Runs on a plain click, before the link navigates. */
	onSelect?: () => void;
	onMessageDrop?: (messageIds: string[]) => void;
};
