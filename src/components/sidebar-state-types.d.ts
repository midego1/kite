import type { ReactNode } from "react";

export type SidebarState = {
	minimal: boolean;
	width: number;
	userId: string | null;
	toggle(): void;
	/** Collapses the sidebar to its icon rail or expands it, and remembers the choice. */
	setMinimal(minimal: boolean): void;
	setWidth(width: number): void;
	mobile: boolean;
	mobileOpen: boolean;
	setMobileOpen(open: boolean): void;
	/** True while a message list header on the page carries the collapse toggle, so the sidebar header drops it. */
	toggleInListHeader: boolean;
	setToggleInListHeader(shown: boolean): void;
};

export type SidebarProviderProps = {
	children: ReactNode;
	expandedWidth?: number;
	mobileOverlay?: boolean;
};

export type SidebarHeaderProps = {
	href: string;
	label?: string;
};

export type SidebarScaffoldProps = {
	header: import("react").ReactNode;
	footer?: import("react").ReactNode;
	/** The account block, pinned under the footer as the last item. */
	account?: import("react").ReactNode;
	children: import("react").ReactNode;
	className?: string;
};
