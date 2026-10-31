import type { LucideIcon } from "lucide-react";
import type { ExternalAccountView } from "@/lib/external-accounts/types";

/** One of the counts above the cards: unread mail, held senders, open suggestions. */
export type StatusChip = {
	id: "unread" | "screener" | "for-you";
	label: string;
	href: string;
	tone: "blue" | "amber" | "violet";
};

export type StatusChipsInput = {
	/** Unread mail in the folder the pane belongs to, that folder's title and where it opens. */
	unread: number;
	folderTitle: string;
	folderHref: string;
	/** Messages the Screener holds, and whether the mailbox screens new senders. */
	held: number;
	screenerOn: boolean;
	/** Open suggestions, null until known, and whether For you is shown at all. */
	forYou: number | null;
	forYouVisible: boolean;
};

export type AccountTone = "ok" | "warn" | "muted";

/** One connected account as the Accounts card lists it. */
export type AccountLine = {
	id: string;
	name: string;
	address: string;
	tone: AccountTone;
	detail: string;
	action: { label: string; href: string } | null;
};

export type AccountLinesInput = {
	accounts: readonly ExternalAccountView[];
	now: Date;
};

/** A line of the Needs attention card that says something is fine. */
export type HealthLine = {
	id: "backups" | "database";
	text: string;
	detail: string;
};

export type QuickAction = {
	id: string;
	label: string;
	icon: LucideIcon;
	/** A keyboard shortcut to show, when the action has one. */
	shortcut?: string;
} & ({ href: string; onSelect?: never } | { href?: never; onSelect: () => void });
