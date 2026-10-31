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
	onMessageDrop?: (messageIds: string[]) => void;
};
