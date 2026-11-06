import { Archive, Clock, Send, ShieldAlert, Star, Trash2, UserCheck } from "lucide-react";
import type { MessageFolderConfig } from "./types";
import { msg } from "@/lib/i18n/translator";

export const inboxFolderConfig: MessageFolderConfig = {
	folder: "inbox",
	title: msg("Inbox"),
	emptyText: msg("No emails"),
	hrefPrefix: "/inbox",
	icon: Star,
	// headerIcons: [MailOpen, Clock],
	showRowBadge: false,
};

export const starredFolderConfig: MessageFolderConfig = {
	folder: "starred",
	title: msg("Starred"),
	emptyText: msg("No starred emails"),
	hrefPrefix: "/starred",
	icon: Star,
	badgeVariant: "outline",
};

export const snoozedFolderConfig: MessageFolderConfig = {
	folder: "snoozed",
	title: msg("Snoozed"),
	emptyText: msg("No snoozed emails"),
	hrefPrefix: "/snoozed",
	icon: Clock,
	badgeVariant: "outline",
};

export const sentFolderConfig: MessageFolderConfig = {
	folder: "sent",
	title: msg("Sent"),
	emptyText: msg("No emails"),
	hrefPrefix: "/sent",
	icon: Send,
	// headerIcons: [MailOpen, Clock],
	badgeVariant: "outline",
};

export const archivedFolderConfig: MessageFolderConfig = {
	folder: "archived",
	title: msg("Archived"),
	emptyText: msg("No archived emails"),
	hrefPrefix: "/archived",
	icon: Archive,
	badgeVariant: "outline",
};

export const spamFolderConfig: MessageFolderConfig = {
	folder: "spam",
	title: msg("Spam"),
	emptyText: msg("No spam"),
	hrefPrefix: "/spam",
	icon: ShieldAlert,
	badgeVariant: "outline",
};

export const trashFolderConfig: MessageFolderConfig = {
	folder: "trash",
	title: msg("Trash"),
	emptyText: msg("No emails in trash"),
	hrefPrefix: "/trash",
	icon: Trash2,
	badgeVariant: "outline",
};

export const screenerFolderConfig: MessageFolderConfig = {
	folder: "screener",
	title: msg("Screener"),
	emptyText: msg("Nobody new is waiting. Mail from senders you have not approved shows up here."),
	hrefPrefix: "/screener",
	icon: UserCheck,
	badgeVariant: "outline",
};
