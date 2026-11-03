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

/** One row of the feature list: a heading, one sentence and the things it covers. */
export type HomeFeatureTheme = {
	id: string;
	title: string;
	summary: string;
	points: string[];
};

export type HomeLink = {
	href: string;
	label: string;
};

export type HomeTextPart = {
	text: string;
	href?: string;
	/** Renders as code, for an environment variable named in the README. */
	code?: boolean;
};

export type HomeCompareRow = {
	label: string;
	/** One cell per column of `compareColumns`: Kite, Mailflare, Email Routing, hosted inboxes. */
	cells: [string, string, string, string];
};

/** One README performance row: the earlier result, then this version. */
export type HomeUpstreamRow = {
	label: string;
	before: string;
	now: string;
};

export type HomeStep = {
	title: string;
	text: string;
};

export type HomeCostRow = {
	provider: string;
	free: string;
	after: string;
};

export type HomeFaq = {
	question: string;
	parts: HomeTextPart[];
};

export type HomeFooterLink = {
	href: string;
	label: string;
};
