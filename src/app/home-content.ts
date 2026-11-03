import { SOURCE_CODE_URL } from "@/lib/source-code";
import type { HomeCompareRow, HomeCostRow, HomeFaq, HomeLink, HomeStep, HomeUpstreamRow } from "./types";

const DOCS = `${SOURCE_CODE_URL}/blob/main/docs`;

export const DEPLOYMENT_GUIDE_URL = `${DOCS}/deployment.md`;
export const SELF_HOST_URL = `${DOCS}/self-hosting.md`;
const PRIVACY_URL = `${DOCS}/privacy.md#usage-statistics`;
export const LIMITATIONS_URL = `${SOURCE_CODE_URL}#known-limitations`;
export const PERFORMANCE_URL = `${SOURCE_CODE_URL}#performance`;
const NOTICE_URL = `${SOURCE_CODE_URL}/blob/main/NOTICE`;
const RELEASES_URL = `${SOURCE_CODE_URL}/releases`;
const ROADMAP_URL = `${SOURCE_CODE_URL}/blob/main/ROADMAP.md`;
const DISCUSSIONS_URL = `${SOURCE_CODE_URL}/discussions`;
const CHANGELOG_URL = `${SOURCE_CODE_URL}/blob/main/CHANGELOG.md`;

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
 * Two rows from the README performance table, in that table's words (Before, then Now). They compare with earlier results, not a benchmark of another project.
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
		text: "Keep the Worker name kite: Email Routing rules use it, and another name breaks receiving. Cloudflare asks for CF_TOKEN, SETUP_TOKEN and APP_ENCRYPTION_KEY. Save that key somewhere safe, because stored provider keys cannot be read without it.",
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
				text: "It runs no update check and no license check. Apart from the services you configure, it contacts Gravatar for contact avatars and Cloudflare's public DNS resolver for DNS checks. It also sends pseudonymous usage statistics (counts as ranges, once a day). These are on by default and you can turn them off at setup, in Admin or with ",
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

/** The headline of the Welcome email and the page's one h1; the text after the comma is set in the quieter tone. */
export const HEADLINE = "Your own inbox for your own domains, running in your Cloudflare account.";

/** The README's "Deploy with an AI coding agent" prompt, verbatim, including the token-handling lines. Do not reword it here; change the README first and then this constant. */
export const DEPLOY_PROMPT = `Install Kite from https://github.com/midego1/kite in my Cloudflare account.
Ask me for my Cloudflare account ID, a scoped deployment API token, and a separate
runtime CF_TOKEN through a secret input. Generate a long random SETUP_TOKEN.
Generate a long random APP_ENCRYPTION_KEY for a new database; when reusing a
database that already holds a Kite install, ask me for the existing
APP_ENCRYPTION_KEY through a secret input, because a new key makes the provider
keys it stores unreadable. Never print, commit, or place these secrets in a command
argument or a tracked file. Use the deployment token only for Wrangler
authentication (CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID).

Read README.md, docs/deployment.md, and wrangler.jsonc first. Keep the Worker name
exactly kite. In the selected account, create or reuse the D1 database kite,
R2 bucket kite-raw, and Queues kite-inbound, kite-outbound, and kite-agent.
Set the D1 database_id in the local Wrangler config without committing that
account-specific ID. Install dependencies,
run npm run deploy, and set CF_TOKEN, SETUP_TOKEN, and APP_ENCRYPTION_KEY as Worker
secrets. Then give me SETUP_TOKEN and a copy of APP_ENCRYPTION_KEY to keep safe:
I need the token to open /setup, and losing the key makes the provider keys Kite
stores unreadable. Do not run remote D1 migrations manually; the /setup flow
initializes the database.

Give me the deployed URL and any remaining Cloudflare account actions. I will
open /setup, create the first admin account, and connect my domain there.`;

export const SETUP_NOTE =
	"Needs a Cloudflare account with a domain on Cloudflare DNS. Plan on about 10 minutes the first time.";
export const BETA_LINE = "Open source · AGPL-3.0 · Early beta";

export function welcomeIntro(appName: string): string {
	return `${appName} is a self-hosted webmail app on Cloudflare Workers. It receives through Email Routing and sends through Cloudflare, Resend or Amazon SES. Your mail stays in your D1 database and R2 bucket (SQLite and local files with Docker). Every feature is free.`;
}

export const FEATURES_LEAD = "Each one is in the app today. None of it needs a plan, a seat or a license key.";
export const DEPLOY_LEAD = (appName: string) =>
	`About 10 minutes the first time, for a domain whose DNS is already on Cloudflare. ${appName} sets up Email Routing for you. You still create the token, set the address and finish setup.`;
export const COST_LEAD = (appName: string) =>
	`Receiving through Cloudflare Email Routing is free. You pay your own Cloudflare and sending-provider usage, and ${appName} itself costs nothing.`;
export const COST_RECEIVING =
	"Receiving: Cloudflare Email Routing is free. Resend receiving is included in every plan. Amazon SES receiving is $0.10 per 1,000 messages, plus small S3 and SNS charges. New Amazon SES accounts start in a sandbox that only delivers to verified addresses.";
export const DOCKER_TEXT =
	"Run one container with SQLite and local files. A built-in SMTP listener, or a small relay Worker, receives mail. Any SMTP relay, Cloudflare, Resend or Amazon SES sends it.";
export const DOCKER_COMMAND = "docker compose up -d --build";
export const PROMPT_NOTE =
	"The prompt is the one in the README. It tells the agent to ask for your tokens, and never to print them.";
export const PROMPT_WARNING =
	"Give the agent your Cloudflare account ID and two separate scoped API tokens through its secret input. Never put them in a public chat, a repository or a committed file.";
export const CLOSING_LINE = "Open source, every feature included, deployed into your own Cloudflare account.";
