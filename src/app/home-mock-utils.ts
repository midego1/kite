import {
	CalendarDays,
	Clock,
	FileText,
	FolderOpen,
	HardDrive,
	Inbox,
	Receipt,
	Send,
	ShieldCheck,
	Sparkles,
	Star,
} from "lucide-react";
import type { HomeMockAttachment, HomeMockParticipant, HomeMockRow, HomeMockSidebarItem } from "./types";

/*
 * Invented demo data for the product preview on the landing page: the same people, subjects and mailbox the
 * README screenshots use (scripts/screenshots/demo-data.ts), so the preview matches what a new install looks
 * like with mail in it. Nothing here is a real address.
 */

export const mockMailbox = { name: "Support", address: "support@example.com", initial: "S" };

export const mockSidebarCore: HomeMockSidebarItem[] = [
	{ label: "Inbox", icon: Inbox, active: true, count: "8" },
	{ label: "Screener", icon: ShieldCheck, count: "3" },
	{ label: "For you", icon: Sparkles, count: "2" },
	{ label: "Starred", icon: Star },
	{ label: "Snoozed", icon: Clock },
	{ label: "Sent", icon: Send },
	{ label: "Drafts", icon: FileText },
];

export const mockSidebarModules: HomeMockSidebarItem[] = [
	{ label: "Calendar", icon: CalendarDays },
	{ label: "Drive", icon: HardDrive },
	{ label: "Subscriptions", icon: Receipt, count: "1" },
	{ label: "Receipts", icon: FolderOpen },
];

export const mockRows: HomeMockRow[] = [
	{
		initial: "S",
		avatarClassName: "bg-neutral-200 text-neutral-700",
		sender: "Sofia Marchetti",
		threadCount: 3,
		subject: "Re: Launch plan for the new inbox",
		time: "02:20 PM",
		selected: true,
		attachment: true,
	},
	{
		initial: "L",
		avatarClassName: "bg-blue-100 text-blue-800",
		sender: "Lena Fischer",
		subject: "Design review notes for the new onboarding",
		time: "02:20 PM",
		unread: true,
	},
	{
		initial: "A",
		avatarClassName: "bg-amber-100 text-amber-800",
		sender: "Ava Lindqvist",
		subject: "Quick question about the API",
		time: "01:58 PM",
		unread: true,
		chip: "New sender",
	},
	{
		initial: "F",
		avatarClassName: "bg-violet-100 text-violet-800",
		sender: "Fabrikam Billing",
		subject: "Your October invoice is ready",
		time: "01:31 PM",
		unread: true,
		attachment: true,
		badge: { icon: Receipt, label: "Subscription found", className: "text-violet-500" },
	},
	{
		initial: "T",
		avatarClassName: "bg-pink-100 text-pink-800",
		sender: "Tom Okafor",
		subject: "Offsite agenda and travel details",
		time: "11:04 AM",
		attachment: true,
		badge: { icon: CalendarDays, label: "Invitation", className: "text-violet-500" },
	},
	{
		initial: "N",
		avatarClassName: "bg-green-100 text-green-800",
		sender: "Northwind Status",
		subject: "Scheduled maintenance this Saturday",
		time: "Yesterday",
	},
	{
		initial: "M",
		avatarClassName: "bg-blue-100 text-blue-800",
		sender: "Maya Chen",
		subject: "Cannot access workspace",
		time: "Yesterday",
	},
];

export const mockThread = {
	subject: "Re: Launch plan for the new inbox",
	count: 3,
	date: "October 28",
	participants: [
		{ initial: "S", name: "Sofia Marchetti", avatarClassName: "bg-neutral-200 text-neutral-700" },
		{ initial: "D", name: "Daniel Osei", avatarClassName: "bg-amber-100 text-amber-800" },
		{ initial: "S", name: "Support", avatarClassName: "bg-violet-100 text-violet-800" },
	] satisfies HomeMockParticipant[],
	from: { name: "Sofia Marchetti", address: "sofia@northwind.test", initial: "S" },
	to: "support@example.com",
	sentAt: "Oct 28, 2026, 02:20 PM",
	body: [
		"Good call, the tour is in. Attached are the updated plan and the rollout checklist; shout if anything is missing before Monday.",
		"Sofia",
	],
	attachments: [
		{ name: "launch-plan.pdf", size: "47 KB", iconClassName: "text-red-600" },
		{ name: "rollout-checklist.csv", size: "2 KB", iconClassName: "text-green-600" },
	] satisfies HomeMockAttachment[],
	suggestion: {
		title: "Reply drafted",
		text: "Thanks Sofia, both files are in. The checklist still needs the DNS step from Daniel. We will confirm Monday morning.",
	},
};
