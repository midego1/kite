import type { LucideIcon } from "lucide-react";
import type { ButtonProps } from "@/components/ui/button";
import type { MailboxSelectorUser } from "@/components/mailbox-selector-types";
import type { ReactNode } from "react";

export type HomeAuthProviderProps = {
	children: ReactNode;
};

export type HomeAccountMenuProps = {
	user: MailboxSelectorUser;
};

export type HomeAction = {
	href: string;
	label: string;
	variant: ButtonProps["variant"];
	/** Opens in a new tab (the deploy button, the source and the docs live on other sites). */
	external?: boolean;
};

/** One theme of the feature grid: a heading, one sentence and the things it covers. */
export type HomeFeatureTheme = {
	id: string;
	icon: LucideIcon;
	title: string;
	summary: string;
	points: string[];
	/** Spans the whole row of the grid, for the seventh card so no card sits alone. */
	wide?: boolean;
};

/** One of the three "how it runs" cards. */
export type HomeRuntimeCard = {
	id: string;
	icon: LucideIcon;
	title: string;
	lines: string[];
	link: { href: string; label: string };
};

export type HomeFooterLink = {
	href: string;
	label: string;
};

export type HomeMockSidebarItem = {
	label: string;
	icon: LucideIcon;
	active?: boolean;
	count?: string;
};

export type HomeMockRow = {
	initial: string;
	/** Tailwind classes of the avatar circle, as the real list colours them per sender. */
	avatarClassName: string;
	sender: string;
	threadCount?: number;
	subject: string;
	time: string;
	unread?: boolean;
	selected?: boolean;
	attachment?: boolean;
	/** The small badge the real list shows for a suggestion, an invite or a sender waiting in the Screener. */
	badge?: { icon: LucideIcon; label: string; className: string };
	/** A chip after the subject, like "New sender" in the Screener's Inbox mode. */
	chip?: string;
};

export type HomeMockParticipant = {
	initial: string;
	name: string;
	avatarClassName: string;
};

export type HomeMockAttachment = {
	name: string;
	size: string;
	iconClassName: string;
};

export type HomeProductMockProps = {
	appName: string;
};

export type HomeSectionProps = {
	appName: string;
};
