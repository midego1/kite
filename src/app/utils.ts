import { Blocks, Cloud, Container, DatabaseBackup, Inbox, Link2, Lock, MailPlus, Scale, Sparkles } from "lucide-react";
import { SOURCE_CODE_URL } from "@/lib/source-code";
import type { HomeAction, HomeFeatureTheme, HomeFooterLink, HomeRuntimeCard } from "./types";

/** The one-click deploy of the repository (README "Deploy"). */
const DEPLOY_URL = `https://deploy.workers.cloudflare.com/?url=${SOURCE_CODE_URL}`;
const SELF_HOST_URL = `${SOURCE_CODE_URL}/blob/main/docs/self-hosting.md`;
const DOCS_URL = `${SOURCE_CODE_URL}/tree/main/docs`;
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

/** The hero's buttons. The first is the main one; the deploy and self-host links open the guides in a new tab. */
export function getHeroActions(isLoggedIn: boolean): HomeAction[] {
	if (isLoggedIn) {
		return [
			{ href: "/inbox", label: "Open dashboard", variant: "default" },
			{ href: DEPLOY_URL, label: "Deploy to Cloudflare", variant: "outline", external: true },
			{ href: SELF_HOST_URL, label: "Self-host with Docker", variant: "outline", external: true },
		];
	}
	return [
		{ href: DEPLOY_URL, label: "Deploy to Cloudflare", variant: "default", external: true },
		{ href: SELF_HOST_URL, label: "Self-host with Docker", variant: "outline", external: true },
		{ href: "/login", label: "Sign in", variant: "outline" },
	];
}

/** Short facts under the hero; every one is documented in the README or docs/. */
export const heroFacts = [
	"Open source, AGPL-3.0",
	"Every feature included, no license keys",
	"AI features need a provider you set up",
	"Your Cloudflare account or one Docker container",
	"Light and dark, on a phone too",
];

export const featureThemes: HomeFeatureTheme[] = [
	{
		id: "mail",
		icon: Inbox,
		title: "A real inbox for you@yourdomain",
		summary:
			"Receive through Cloudflare Email Routing, Resend or Amazon SES, and send through the one you choose per domain.",
		points: [
			"Conversations, search, folders, stars, snooze, archive and undo for the things you regret.",
			"The Screener holds mail from people you have never written to until you approve or deny them.",
			"A spam filter that learns from you, phishing warnings for misleading links and failed sender checks, and the abuse.ch lists on request.",
			"Shared mailboxes, All mailboxes in one Inbox, routing rules, signatures, automatic replies, send preview and undo send.",
			"Keyboard shortcuts, a command palette, resizable panes, a dyslexia-friendly font and one pane at a time on a phone.",
		],
	},
	{
		id: "accounts",
		icon: MailPlus,
		title: "Your other accounts, in the same place",
		summary:
			"Connect Gmail, Google Workspace, iCloud Mail, Yahoo, AOL, Fastmail or any IMAP provider with an app password. Outlook.com, Hotmail and Microsoft 365 cannot be connected yet (they need OAuth).",
		points: [
			"New mail is checked every few minutes and delivered like mail Kite receives itself: spam filter, rules, Screener and notifications included.",
			"Import existing mail in the background, folder by folder, and keep working while it runs.",
			"Send as the account's address through the provider's own server, so it carries their SPF and DKIM.",
			"Apart from sending as that address (and an optional copy in its Sent folder), Kite only reads at the provider. It never deletes, moves or marks anything there.",
		],
	},
	{
		id: "ai",
		icon: Sparkles,
		title: "AI that reads and drafts, and asks before it acts",
		summary:
			"Bring your own provider: Cloudflare Workers AI, Anthropic, OpenAI or any OpenAI-compatible endpoint, with daily spend caps.",
		points: [
			"Ask the assistant about your mail, let it draft and revise replies, and summarize a conversation in one card.",
			"Write with Kite in the composer writes or rewrites the body, in your own writing style if you let it learn one.",
			"Automatic reading suggests replies, calendar answers, phishing warnings and subscriptions on For you. Off by default, suggestions only, with undo.",
			"Nothing is sent without you: every AI draft goes through a review in Kite, also over MCP and JMAP.",
		],
	},
	{
		id: "modules",
		icon: Blocks,
		title: "Calendar, Drive, Booking and more, as modules",
		summary:
			"Six modules the owner can turn off for the install or per user. What is off disappears and nothing is deleted.",
		points: [
			"Calendar with day, week and month views, repeating events, time zones and email invitations.",
			"Booking pages: a public link where anyone can book a free time on your calendar.",
			"Drive keeps files and folders next to your mail, with resumable uploads, previews, sharing and public links with a password and an expiry.",
			"Money Watch spots subscriptions in receipts and invoices and reminds you before a renewal. Email templates and Mail import complete the set.",
		],
	},
	{
		id: "data",
		icon: DatabaseBackup,
		title: "Backups and storage that scale",
		summary:
			"Daily backups, kept for 14 days on new installs, streamed to storage in parts so a large mailbox fits in Worker limits.",
		points: [
			"Restores are checked first, read in pages and written in batches, with a safety backup and rollback when one fails part way.",
			"Backups can include the raw mail and attachments, and restore the files that are missing.",
			"Files go to your R2 bucket by default, or to Amazon S3, Backblaze B2, Wasabi, Hetzner, MinIO and other S3-compatible stores, chosen separately for Mail, Drive and Backups.",
			"Direct uploads send large Drive files from the browser straight to the store.",
		],
	},
	{
		id: "integrations",
		icon: Link2,
		title: "JMAP, an API, webhooks and MCP",
		summary:
			"Everything you can do in the app, you can do from code, with keys scoped to the mailboxes and permissions you choose.",
		points: [
			"JMAP for clients that speak it, and app passwords limited to one mailbox.",
			"A REST API with scoped keys and webhooks for new mail, sends and module events, with retries you can watch.",
			"An MCP server for AI clients: only the tools a key allows, every call in the audit log, sending only after a review in Kite.",
		],
	},
	{
		id: "privacy",
		icon: Lock,
		wide: true,
		title: "Your data, on your account",
		summary:
			"Mail lives in your own database and your own bucket. There is no update check or license check, and nothing leaves your install except what you configure.",
		points: [
			"HTML mail renders in a sandboxed frame without scripts; remote images stay blocked until you allow them.",
			"Provider keys and account passwords are encrypted at rest; sessions live in an HttpOnly cookie; two-step sign-in with an authenticator app.",
			"Besides the services you set up, Kite contacts only Gravatar for avatars and Cloudflare's DNS resolver for checks.",
			"Usage statistics (rough counts, no content) are on by default and go once a day to the Kite project. Turn them off at setup or in Admin → General.",
		],
	},
];

export const runtimeCards: HomeRuntimeCard[] = [
	{
		id: "cloudflare",
		icon: Cloud,
		title: "In your Cloudflare account",
		lines: [
			"One click deploys a Worker with a D1 database, an R2 bucket and queues. Receiving through Email Routing is free; sending uses Cloudflare, Resend or Amazon SES.",
			"Plan on about ten minutes the first time: an API token, two secrets and the app's address, then /setup creates your admin account and connects a domain.",
		],
		link: { href: DEPLOY_URL, label: "Deploy to Cloudflare" },
	},
	{
		id: "docker",
		icon: Container,
		title: "Or one Docker container",
		lines: [
			"The same app on any server, with SQLite and local files instead of D1 and R2, and S3-compatible storage if you want it.",
			"A built-in SMTP listener or a small relay Worker receives mail; any SMTP relay, Cloudflare, Resend or SES sends it.",
		],
		link: { href: SELF_HOST_URL, label: "Self-hosting guide" },
	},
	{
		id: "source",
		icon: Scale,
		title: "Open source, AGPL-3.0",
		lines: [
			"Every feature is free and the source is yours to read, run and change. Access is set by roles and mailbox sharing, never by a license key.",
			"Early beta: it works and it is tested on every change, with over 2,000 unit tests and 400 browser tests, and some things are still rough.",
		],
		link: { href: SOURCE_CODE_URL, label: "Source on GitHub" },
	},
];

export const footerLinks: HomeFooterLink[] = [
	{ href: SOURCE_CODE_URL, label: "Source code" },
	{ href: DOCS_URL, label: "Documentation" },
	{ href: CHANGELOG_URL, label: "Changelog" },
	{ href: LICENSE_URL, label: "AGPL-3.0 license" },
];
