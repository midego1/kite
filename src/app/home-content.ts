import { SOURCE_CODE_URL } from "@/lib/source-code";
import type { HomeCompareRow, HomeCostRow, HomeFaq, HomeLink, HomeStep, HomeUpstreamRow } from "./types";

const DOCS = `${SOURCE_CODE_URL}/blob/main/docs`;

export const DEPLOYMENT_GUIDE_URL = `${DOCS}/deployment.md`;
export const SELF_HOST_URL = `${DOCS}/self-hosting.md`;
export const PRIVACY_URL = `${DOCS}/privacy.md#usage-statistics`;
export const LIMITATIONS_URL = `${SOURCE_CODE_URL}#known-limitations`;
export const PERFORMANCE_URL = `${SOURCE_CODE_URL}#performance`;
export const NOTICE_URL = `${SOURCE_CODE_URL}/blob/main/NOTICE`;
export const RELEASES_URL = `${SOURCE_CODE_URL}/releases`;
export const ROADMAP_URL = `${SOURCE_CODE_URL}/blob/main/ROADMAP.md`;
export const DISCUSSIONS_URL = `${SOURCE_CODE_URL}/discussions`;
export const CHANGELOG_URL = `${SOURCE_CODE_URL}/blob/main/CHANGELOG.md`;

/** Approved proof chips. No star count: the project is too young for one to mean anything. */
export const proofChips = [
	"AGPL-3.0",
	"Cloudflare · Resend · Amazon SES",
	"D1 + R2 in your account",
	"$0 to receive via Email Routing",
	"2,000+ unit · 400+ browser tests in CI",
	"Docker + SQLite option",
];

export const compareColumns = ["Kite", "Mailflare", "Email Routing alone", "Hosted inboxes"] as const;

/** Cells are the README comparison table, cut to the rows the landing brief keeps. */
export const compareRows: HomeCompareRow[] = [
	{
		label: "What it is",
		cells: [
			"A fork of Mailflare that runs in your Cloudflare account, developed independently",
			"The original self-hosted inbox by hieunc229",
			"Forwards mail for your domain to an address or a Worker",
			"A managed mailbox service",
		],
	},
	{
		label: "Sending as your domain",
		cells: [
			"Cloudflare, Resend or Amazon SES, per domain",
			"Cloudflare, Resend or Amazon SES",
			"No sending inbox",
			"Yes",
		],
	},
	{
		label: "Where your mail lives",
		cells: [
			"Your D1 database and R2 bucket, or an S3-compatible store for files (SQLite and local files with Docker)",
			"Your Cloudflare account",
			"Passes through, then lives wherever you forward it",
			"The provider's servers",
		],
	},
	{
		label: "Price model",
		cells: [
			"Free software, every feature included. You pay your own Cloudflare and provider usage",
			"AGPL-3.0 core, with Pro and Team features behind a paid license key",
			"Free",
			"Per user per month",
		],
	},
	{
		label: "Maturity",
		cells: [
			"Young project, small community",
			"The original, with a much larger community and its own project site",
			"A Cloudflare product",
			"Established products with support teams",
		],
	},
	{
		label: "Deliverability help",
		cells: [
			"Documentation only",
			"Documentation",
			"Not applicable",
			"The strongest of these: support, reputation management and spam filtering at scale",
		],
	},
	{
		label: "Best when",
		cells: [
			"You want an inbox you control, with an API and no license keys",
			"You want the original project or a multilingual interface",
			"You only need forwarding",
			"You want polish, mobile apps and someone else on call",
		],
	},
];

/**
 * Two rows from the README performance table, in that table's words (Before, then Now).
 * The README measures them on a production build in a plain Chrome profile.
 */
export const upstreamRows: HomeUpstreamRow[] = [
	{
		label: "Opening a folder for the first time",
		before: "~340 ms with an empty page and loading bar",
		now: "~35–50 ms",
	},
	{
		label: "Backing up a 53 MB database",
		before: "Fails: Worker exceeds its 128 MB memory limit",
		now: "Completes",
	},
];

/** The five steps in the README's Deploy section, shortened. The guide has the permissions and the troubleshooting. */
export const deploySteps: HomeStep[] = [
	{
		title: "Create a scoped CF_TOKEN",
		text: "In the Cloudflare dashboard, create a token with DNS, zone and Email Routing permissions, plus Email Sending: Edit if Cloudflare will send mail. It is separate from the token Cloudflare uses to deploy.",
	},
	{
		title: "Click Deploy to Cloudflare",
		text: "Keep the Worker name kite. Email Routing rules and the Worker's self-binding use that name, and another name breaks receiving.",
	},
	{
		title: "Add APP_URL",
		text: "Set it to the app's public HTTPS address. Password reset mail, and receiving through Resend or Amazon SES, need it.",
	},
	{
		title: "Open /setup",
		text: "Kite checks the install, prepares the database and creates your admin account. A red item has to be fixed before you continue.",
	},
	{
		title: "Connect a domain",
		text: "Add a domain whose DNS is already on Cloudflare, choose who receives its mail, and create your first mailbox.",
	},
];

/**
 * Sending prices as stated in the README Cost table on 2 Nov 2026. The footnote tells the reader to recheck,
 * because these numbers are the providers', not a promise.
 */
export const costRows: HomeCostRow[] = [
	{
		provider: "Resend",
		free: "3,000 emails a month (100 a day), 3 domains",
		after: "From $20/month for 50,000 emails",
	},
	{
		provider: "Amazon SES",
		free: "$200 AWS credit for new accounts (about 2 million emails). The free plan lasts 6 months and credits expire after 12.",
		after: "$0.10 per 1,000 emails",
	},
	{
		provider: "Cloudflare Email Sending",
		free: "None",
		after: "Needs a paid Workers plan ($5/month)",
	},
];

export const costLinks: HomeLink[] = [
	{ href: "https://resend.com/pricing", label: "Resend" },
	{ href: "https://aws.amazon.com/ses/pricing/", label: "Amazon SES" },
	{ href: "https://developers.cloudflare.com/workers/platform/pricing/", label: "Cloudflare" },
];

/** The short list from the landing brief. The README's known-limitations section is the full one. */
export const limitations = [
	"English-only interface.",
	"Cloudflare DNS is required for the default install.",
	"No IMAP or SMTP server for desktop clients.",
	"No native mobile app. The web app has a mobile layout.",
	"Updates and database migrations are manual.",
	"Cloudflare's own sending needs a paid Workers plan, and caps message size and recipients.",
	"No published third-party security audit.",
];

export const openLinks: HomeLink[] = [
	{ href: CHANGELOG_URL, label: "Changelog" },
	{ href: RELEASES_URL, label: "Releases" },
	{ href: ROADMAP_URL, label: "Roadmap" },
	{ href: DISCUSSIONS_URL, label: "Discussions" },
];

export const faqs: HomeFaq[] = [
	{
		question: "How is Kite related to Mailflare?",
		parts: [
			{ text: "Kite started as a fork of " },
			{ text: "Mailflare", href: "https://github.com/hieunc229/mailflare" },
			{
				text: " by hieunc229 and is now developed independently under the same AGPL-3.0 license. It no longer syncs with Mailflare. The original credits are kept in ",
			},
			{ text: "NOTICE", href: NOTICE_URL },
			{ text: "." },
		],
	},
	{
		question: "What does it cost?",
		parts: [
			{
				text: "The software is free, and every feature is included. You pay your own Cloudflare and sending-provider usage. Receiving through Email Routing is free.",
			},
		],
	},
	{
		question: "Do I need Cloudflare?",
		parts: [
			{
				text: "For the default install, yes, with the domain's DNS on Cloudflare. A Docker build runs on any server with SQLite and local files, and you set DNS records by hand.",
			},
		],
	},
	{
		question: "Can I use Apple Mail, Outlook or Thunderbird?",
		parts: [
			{
				text: "Not yet. Kite has no IMAP or SMTP server. It offers the web app, JMAP, an API, webhooks and MCP.",
			},
		],
	},
	{
		question: "Does Kite phone home?",
		parts: [
			{
				text: "It runs no update check and no license check. It sends pseudonymous usage statistics (counts as ranges, once a day). These are on by default and you can turn them off at setup, in Admin or with ",
			},
			{ text: "KITE_TELEMETRY=0", code: true },
			{ text: ". " },
			{ text: "What is sent", href: PRIVACY_URL },
			{ text: "." },
		],
	},
	{
		question: "Will the AI send mail on its own?",
		parts: [{ text: "No. It drafts, and you confirm each send. Automatic reading is off by default." }],
	},
	{
		question: "How do I move my mail in?",
		parts: [
			{
				text: "Use IMAP import, which runs as a background job, plus import and export in the app. In-app backups are streamed to object storage.",
			},
		],
	},
];
