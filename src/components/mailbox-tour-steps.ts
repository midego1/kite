import { Inbox, MailOpen, ShieldAlert, ShieldCheck, Sparkles, type LucideIcon } from "lucide-react";
import { msg } from "@/lib/i18n/translator";
import type { MessageKey } from "@/lib/i18n/i18n-types";

export type MailboxTourStep = {
	id: string;
	icon: LucideIcon;
	title: MessageKey;
	description: MessageKey;
};

/** The first-login tour for a mailbox user who is not the owner, in the order someone would meet each part. */
export const MAILBOX_TOUR_STEPS: readonly MailboxTourStep[] = [
	{
		id: "layout",
		icon: Inbox,
		title: msg("Welcome to your mailbox"),
		description: msg(
			"The sidebar on the side opens your folders and views, the list in the middle shows your messages, and reading one opens it beside the list.",
		),
	},
	{
		id: "screener",
		icon: ShieldCheck,
		title: msg("Screener"),
		description: msg(
			"The first time someone new writes to you, their message waits for a decision instead of landing straight in your inbox. Approve them and everything they send afterwards arrives normally; deny them and their mail goes to Spam.",
		),
	},
	{
		id: "for-you",
		icon: Sparkles,
		title: msg("For you"),
		description: msg(
			"For you gathers suggestions worth a look: messages the assistant thinks need a reply or an action, in one place instead of spread across your folders.",
		),
	},
	{
		id: "phishing",
		icon: ShieldAlert,
		title: msg("Not phishing and trusted senders"),
		description: msg(
			"A message flagged as possible phishing can be marked Not phishing when it is genuine, which trusts that sender. Approved and denied senders are listed under Settings → Inbox → Screener, so you can review or change them any time.",
		),
	},
	{
		id: "conversation-view",
		icon: MailOpen,
		title: msg("Conversation view"),
		description: msg(
			"Related messages can be grouped into one row per conversation instead of one per message. Turn it on or off under Settings → Inbox.",
		),
	},
];
