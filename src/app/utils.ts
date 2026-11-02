import { Calendar, Cloud, Inbox, Link2, ShieldCheck, Sparkles } from "lucide-react";
import { SOURCE_CODE_URL } from "@/lib/source-code";
import type { HomeAction, HomeFeatureTheme, HomeFooterLink } from "./types";

/** The one-click deploy of the repository (README "Deploy"). */
export const DEPLOY_URL = `https://deploy.workers.cloudflare.com/?url=${SOURCE_CODE_URL}`;
export const DOCS_URL = `${SOURCE_CODE_URL}/tree/main/docs`;
const CHANGELOG_URL = `${SOURCE_CODE_URL}/blob/main/CHANGELOG.md`;
const LICENSE_URL = `${SOURCE_CODE_URL}/blob/main/LICENSE`;
export const UPSTREAM_URL = "https://github.com/hieunc229/mailflare";

/** The header's buttons for a visitor without a session; a signed-in user gets the account menu instead. */
export function getHomeActions(isLoggedIn: boolean): HomeAction[] {
	if (isLoggedIn) {
		return [{ href: "/inbox", label: "Open dashboard", variant: "default" }];
	}
	return [
		{ href: "/login", label: "Sign in", variant: "outline" },
		{ href: DEPLOY_URL, label: "Deploy to Cloudflare", variant: "default", external: true },
	];
}

/** The hero's buttons. A signed-in user opens the dashboard; a visitor deploys or reads the source. */
export function getHeroActions(isLoggedIn: boolean): HomeAction[] {
	if (isLoggedIn) {
		return [
			{ href: "/inbox", label: "Open dashboard", variant: "default" },
			{ href: SOURCE_CODE_URL, label: "View on GitHub", variant: "outline", external: true },
		];
	}
	return [
		{ href: DEPLOY_URL, label: "Deploy to Cloudflare", variant: "default", external: true },
		{ href: SOURCE_CODE_URL, label: "View on GitHub", variant: "outline", external: true },
	];
}

/**
 * The six feature blocks. Wording follows the landing brief, and every point is something the app does today
 * (README "What you can do" and "Known limitations").
 */
export const featureThemes: HomeFeatureTheme[] = [
	{
		id: "inbox",
		icon: Inbox,
		title: "A real inbox, not just forwarding",
		summary:
			"Threads, search, folders, stars, snooze, archive, and personal or shared mailboxes, all in one unified inbox.",
		points: ["Resizable panes, Gmail-style keys and a Cmd+K palette."],
	},
	{
		id: "providers",
		icon: Cloud,
		title: "Pick a provider per domain",
		summary: "Each domain receives and sends through Cloudflare, Resend or Amazon SES.",
		points: ["Email Routing and DNS are set up on Cloudflare, and it asks before it replaces existing MX records."],
	},
	{
		id: "calendar",
		icon: Calendar,
		title: "Calendar, booking pages and Drive",
		summary: "Day, week and month views, invitations by email, and public booking links.",
		points: [
			"Files and folders sit next to your mail, with sharing and expiring public links.",
			"Each module can be switched off.",
		],
	},
	{
		id: "safety",
		icon: ShieldCheck,
		title: "Safer by default",
		summary:
			"Email HTML renders in a sandboxed frame with no scripts. Remote images stay blocked until you allow them.",
		points: [
			"Sessions live in HttpOnly cookies, and provider keys are encrypted with AES-GCM.",
			"A local spam filter learns from you, phishing warnings flag risky mail, and a Screener holds first-time senders.",
			"Undo send gives you a moment to take a message back.",
		],
	},
	{
		id: "ai",
		icon: Sparkles,
		title: "AI that drafts, never sends",
		summary: "Ask about your mail and get reply drafts. You confirm every send.",
		points: [
			"Automatic reading is off by default and has spend caps. You bring your own provider.",
			"AI clients connect over MCP, with scoped keys that only see the tools they are allowed.",
		],
	},
	{
		id: "api",
		icon: Link2,
		title: "Open APIs",
		summary: "JMAP, a REST API, webhooks and MCP.",
		points: ["IMAP is used to import mail and to read accounts you connect. There is no IMAP server for desktop apps."],
	},
];

export const footerLinks: HomeFooterLink[] = [
	{ href: SOURCE_CODE_URL, label: "Source code" },
	{ href: DOCS_URL, label: "Documentation" },
	{ href: CHANGELOG_URL, label: "Changelog" },
	{ href: LICENSE_URL, label: "AGPL-3.0 license" },
];
