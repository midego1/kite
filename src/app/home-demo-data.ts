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
import type { DemoMessage, DemoPerson, DemoSidebarItem } from "./home-demo-types";

/*
 * Invented demo data for the live demo on the landing page: the same people, subjects and mailbox the README
 * screenshots use (scripts/screenshots/demo-data.ts), so it looks like a new install with mail in it. Nothing
 * here is a real address, and nothing the demo does leaves the browser.
 */

export const demoMailbox = { name: "Support", address: "support@example.com", initial: "S" };

export const demoSidebarCore: DemoSidebarItem[] = [
	{ view: "inbox", label: "Inbox", icon: Inbox },
	{ view: "screener", label: "Screener", icon: ShieldCheck },
	{ view: "for-you", label: "For you", icon: Sparkles },
	{ view: "starred", label: "Starred", icon: Star },
	{ view: "snoozed", label: "Snoozed", icon: Clock },
	{ view: "sent", label: "Sent", icon: Send },
	{ view: "drafts", label: "Drafts", icon: FileText },
];

export const demoSidebarModules: DemoSidebarItem[] = [
	{ view: "calendar", label: "Calendar", icon: CalendarDays },
	{ view: "drive", label: "Drive", icon: HardDrive },
	{ view: "subscriptions", label: "Subscriptions", icon: Receipt },
	{ view: "receipts", label: "Receipts", icon: FolderOpen },
];

export const demoViewTitles: Record<string, string> = {
	inbox: "Inbox",
	screener: "Screener",
	"for-you": "For you",
	starred: "Starred",
	snoozed: "Snoozed",
	sent: "Sent",
	drafts: "Drafts",
	receipts: "Receipts",
	calendar: "Calendar",
	drive: "Drive",
	subscriptions: "Subscriptions",
};

const support: DemoPerson = {
	name: "Support",
	address: "support@example.com",
	initial: "S",
	avatarClassName: "bg-violet-100 text-violet-800",
};
const sofia: DemoPerson = {
	name: "Sofia Marchetti",
	address: "sofia@northwind.test",
	initial: "S",
	avatarClassName: "bg-neutral-200 text-neutral-700",
};
const daniel: DemoPerson = {
	name: "Daniel Osei",
	address: "daniel@northwind.test",
	initial: "D",
	avatarClassName: "bg-amber-100 text-amber-800",
};
const lena: DemoPerson = {
	name: "Lena Fischer",
	address: "lena@northwind.test",
	initial: "L",
	avatarClassName: "bg-blue-100 text-blue-800",
};
const ava: DemoPerson = {
	name: "Ava Lindqvist",
	address: "ava@lindqvist.example",
	initial: "A",
	avatarClassName: "bg-amber-100 text-amber-800",
};
const fabrikam: DemoPerson = {
	name: "Fabrikam Billing",
	address: "billing@fabrikam.example",
	initial: "F",
	avatarClassName: "bg-violet-100 text-violet-800",
};
const tom: DemoPerson = {
	name: "Tom Okafor",
	address: "tom@northwind.test",
	initial: "T",
	avatarClassName: "bg-pink-100 text-pink-800",
};
const status: DemoPerson = {
	name: "Northwind Status",
	address: "status@northwind.test",
	initial: "N",
	avatarClassName: "bg-green-100 text-green-800",
};
const maya: DemoPerson = {
	name: "Maya Chen",
	address: "maya@contoso.example",
	initial: "M",
	avatarClassName: "bg-blue-100 text-blue-800",
};
const jules: DemoPerson = {
	name: "Jules Baptiste",
	address: "jules@growthloop.example",
	initial: "J",
	avatarClassName: "bg-green-100 text-green-800",
};
const priya: DemoPerson = {
	name: "Priya Raman",
	address: "priya@northwind.test",
	initial: "P",
	avatarClassName: "bg-pink-100 text-pink-800",
};
const wingtip: DemoPerson = {
	name: "Wingtip Toys",
	address: "orders@wingtip.example",
	initial: "W",
	avatarClassName: "bg-amber-100 text-amber-800",
};

const pdf = (name: string, size: string) => ({ name, size, iconClassName: "text-red-600" });
const sheet = (name: string, size: string) => ({ name, size, iconClassName: "text-green-600" });
const ics = (name: string, size: string) => ({ name, size, iconClassName: "text-violet-600" });

function message(
	id: string,
	from: DemoPerson,
	subject: string,
	time: string,
	sentAt: string,
	body: string[],
	rest: Partial<DemoMessage> = {},
): DemoMessage {
	return {
		id,
		from,
		to: demoMailbox.address,
		subject,
		time,
		sentAt,
		status: "inbox",
		unread: false,
		starred: false,
		snoozed: false,
		body,
		participants: [from, support],
		attachments: [],
		summary: { overview: body[0], points: [] },
		...rest,
	};
}

export const demoMessages: DemoMessage[] = [
	message(
		"launch-plan",
		sofia,
		"Re: Launch plan for the new inbox",
		"02:20 PM",
		"Oct 28, 2026, 02:20 PM",
		[
			"Good call, the tour is in. Attached are the updated plan and the rollout checklist; shout if anything is missing before Monday.",
			"Sofia",
		],
		{
			participants: [sofia, daniel, support],
			attachments: [pdf("launch-plan.pdf", "47 KB"), sheet("rollout-checklist.csv", "2 KB")],
			earlier: [
				{
					from: daniel,
					time: "Oct 28, 2026, 01:05 PM",
					body: "Looks good. Can we add a short tour for the command palette? Most beta users will not find it on their own.",
				},
				{
					from: sofia,
					time: "Oct 28, 2026, 11:40 AM",
					body: "Hi both, here is the launch plan for the new inbox. The rollout starts with the beta group on Monday.",
				},
			],
			suggestion: {
				kind: "reply",
				title: "Reply drafted",
				text: "Thanks Sofia, both files are in. The checklist still needs the DNS step from Daniel. We will confirm Monday morning.",
				actionLabel: "Review draft",
			},
			summary: {
				overview:
					"Sofia shared the final launch plan and rollout checklist; Daniel asked for a short tour of the command palette, which is now in.",
				points: ["Asks: confirm nothing is missing before Monday", "Dates: rollout starts Monday with the beta group"],
			},
		},
	),
	message(
		"design-review",
		lena,
		"Design review notes for the new onboarding",
		"02:20 PM",
		"Oct 28, 2026, 02:20 PM",
		[
			"Notes from this morning's review are in the doc. Two things still open: the empty state copy on the first screen, and whether the domain step can be skipped for people who want to try the inbox first.",
			"I lean towards letting them skip it. Thoughts?",
			"Lena",
		],
		{
			unread: true,
			summary: {
				overview:
					"Lena's review left two open points: the first screen's empty-state copy and whether the domain step can be skipped.",
				points: ["Asks: your view on skipping the domain step", "Decisions: Lena leans towards allowing it"],
			},
		},
	),
	message(
		"api-question",
		ava,
		"Quick question about the API",
		"01:58 PM",
		"Oct 28, 2026, 01:58 PM",
		[
			"Hi, I run a small newsletter and found Kite through a friend. Can the API send on a schedule, and does a scoped key let me read only one mailbox?",
			"Thanks, Ava",
		],
		{
			unread: true,
			screening: true,
			summary: {
				overview:
					"Ava, a new sender, asks whether the API can schedule sends and whether a key can be limited to one mailbox.",
				points: ["Asks: scheduled sending; one-mailbox keys"],
			},
		},
	),
	message(
		"invoice",
		fabrikam,
		"Your October invoice is ready",
		"01:31 PM",
		"Oct 28, 2026, 01:31 PM",
		[
			"Your Fabrikam Team plan renews on November 3. This month's invoice (US$17.99) is attached. Nothing to do if your card on file is current.",
			"The Fabrikam billing team",
		],
		{
			unread: true,
			attachments: [pdf("fabrikam-invoice-2026-10.pdf", "31 KB")],
			badge: { icon: Receipt, label: "Subscription found", className: "text-violet-500" },
			suggestion: {
				kind: "subscription",
				title: "Fabrikam US$17.99/month, renews 3 Nov. Track it?",
				text: "Records this invoice and reminds you before the renewal.",
				actionLabel: "Track",
			},
			summary: {
				overview: "Fabrikam's October invoice for the Team plan (US$17.99) is attached; the plan renews on November 3.",
				points: ["Dates: renews 3 Nov", "Next steps: none if the card on file is current"],
			},
		},
	),
	message(
		"offsite",
		tom,
		"Offsite agenda and travel details",
		"11:04 AM",
		"Oct 28, 2026, 11:04 AM",
		[
			"Agenda for the offsite is attached, plus the calendar invitation for the planning session on Thursday at 10:00. Trains leave at 08:12 and 08:42; I booked the earlier one.",
			"Tom",
		],
		{
			starred: true,
			attachments: [pdf("offsite-agenda.pdf", "88 KB"), ics("planning-session.ics", "1 KB")],
			badge: { icon: CalendarDays, label: "Invitation", className: "text-violet-500" },
			suggestion: {
				kind: "invite",
				title: "Planning session, Thu 10:00 to 11:30. You are free.",
				text: "Accepting answers Tom's invitation and adds the event to your calendar.",
				actionLabel: "Accept",
			},
			summary: {
				overview: "Tom sent the offsite agenda and an invitation for the planning session on Thursday at 10:00.",
				points: ["Dates: Thursday 10:00, train at 08:12", "Next steps: answer the invitation"],
			},
		},
	),
	message(
		"maintenance",
		status,
		"Scheduled maintenance this Saturday",
		"Yesterday",
		"Oct 27, 2026, 04:10 PM",
		[
			"The API and the dashboard will be read-only on Saturday between 02:00 and 02:30 UTC while we move the primary database. Mail keeps flowing; nothing is lost.",
		],
		{
			summary: {
				overview: "Northwind announces a 30-minute read-only window on Saturday at 02:00 UTC for a database move.",
				points: ["Dates: Saturday 02:00 to 02:30 UTC"],
			},
		},
	),
	message(
		"workspace",
		maya,
		"Cannot access workspace",
		"Yesterday",
		"Oct 27, 2026, 09:52 AM",
		[
			'Since this morning I get "workspace not found" when I open the dashboard. My colleague Ben can still get in. I tried another browser and a password reset.',
			"Maya",
		],
		{
			unread: true,
			summary: {
				overview:
					"Maya cannot open her workspace since this morning while a colleague can; she already tried another browser and a reset.",
				points: ["Asks: restore her access", "Next steps: check her membership"],
			},
		},
	),
	message(
		"partnership",
		jules,
		"Partnership idea for Northwind",
		"Yesterday",
		"Oct 27, 2026, 08:15 AM",
		[
			"We help SaaS teams grow their newsletter. I would love 15 minutes to show you what we did for two companies like yours.",
		],
		{ unread: true, screening: true },
	),
	message(
		"quarterly",
		priya,
		"Quarterly support metrics",
		"Mon",
		"Oct 26, 2026, 03:30 PM",
		[
			"The Q3 numbers are in: median first reply under 40 minutes, and the backlog is at its lowest since March. Full report attached.",
		],
		{ snoozed: true, attachments: [pdf("support-metrics-q3.pdf", "120 KB")] },
	),
	message(
		"order",
		wingtip,
		"Your order #4821 has shipped",
		"Oct 24",
		"Oct 24, 2026, 06:02 PM",
		["Your order #4821 (2 items) left our warehouse today and should arrive by Friday. Track it from your account."],
		{ folder: "receipts" },
	),
	message(
		"sent-maya",
		support,
		"Re: Cannot access workspace",
		"Yesterday",
		"Oct 27, 2026, 10:20 AM",
		[
			"Hi Maya, thanks for the details. Your account was moved to a new team on Friday; I have added you back to the Northwind workspace. Can you try again?",
		],
		{ status: "sent", to: maya.address, participants: [support, maya] },
	),
	message(
		"sent-booking",
		support,
		"Your booking is confirmed",
		"Oct 23",
		"Oct 23, 2026, 11:00 AM",
		["Your onboarding call is booked for Oct 30 at 14:00. The link is in the calendar invitation."],
		{ status: "sent", to: "kim@brightline.example", participants: [support] },
	),
	message(
		"draft-hotel",
		support,
		"Offsite travel: hotel options",
		"Today",
		"Oct 28, 2026, 09:12 AM",
		["Tom, two hotels within walking distance of the venue:", "- The Linden, from 140", "- Riverside House, from 120"],
		{ status: "draft", to: tom.address, participants: [support, tom] },
	),
];

/** The chat answers, in the order the visitor asks; a demo cannot read mail, so every answer is written down. */
export const demoChatReplies = [
	"Two messages need a reply today: Sofia Marchetti about the launch plan (a draft is ready for you to review) and Maya Chen, who cannot access her workspace.",
	"Fabrikam bills US$17.99 a month and the October invoice arrived at 01:31 PM. Money Watch can track it and remind you before 3 November.",
	"This is a demo with invented mail. In Kite the assistant reads only the mailbox you choose, and it never sends anything without your review.",
];

export const demoChatOpening = "Hi! I can answer questions about this demo mailbox. Try: what needs a reply today?";
