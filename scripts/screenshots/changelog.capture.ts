import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";
import sharp from "sharp";
import { ADMIN, STORAGE_STATE } from "../../e2e/support/constants";
import { useFakeProvider as connectFakeProvider } from "../../e2e/support/agent";
import { startFakeModel } from "../../e2e/support/fake-model";
import type { FakeModel } from "../../e2e/support/fake-model-types";
import { apiContext, postInbound, waitForMessage } from "../../e2e/support/helpers";
import { turnScreenerOff } from "../../e2e/support/screener";
import {
	RTL_MAIL,
	seedDemoData,
	seedPagedMail,
	seedPaymentsDemo,
	seedRtlMail,
	seedThaiMail,
	THAI_MAIL,
	THAI_MAIL_TRANSLATED,
	THREAD,
} from "./demo-data";
import { mockConnectedAccountAuthRecheck, mockForYou, mockForYouPreview } from "./demo-mocks";
import { sampleMessage, startFakeImap } from "../../tests/support/fake-imap.mjs";

// Screenshots for the changelog (docs/releasing.md#screenshots-in-the-changelog), taken against the isolated,
// seeded e2e server, so only invented demo data appears. They land in public/changelog/<name>.webp, ready for a
// fragment's `![what it shows](/changelog/<name>.webp)`. Run them with `npm run changelog:screenshot`; a plain
// `npm run screenshots` skips them, so existing images are never rewritten by accident.
// Add a shot to SHOTS for a new change: `open` gets a page signed in as the demo admin and returns the element
// (a dialog, a panel) or the page to capture.
const RECORD = process.env.KITE_CHANGELOG_SHOTS === "1";
const OUT_DIR = path.join(process.cwd(), "public", "changelog");
/** The limits scripts/changelog-images.mjs enforces. */
const MAX_WIDTH = 1600;
const MAX_BYTES = 200 * 1024;

type Theme = "light" | "dark";
type Shot = {
	/** The file name without `.webp`: lowercase, dated, e.g. `2026-11-02-whats-new-images`. */
	name: string;
	theme?: Theme;
	viewport?: { width: number; height: number };
	open: (page: Page) => Promise<Locator | Page>;
};

/** Demo mail source for the import screenshot: a fake IMAP server on 127.0.0.1 with invented folders and sizes. */
let demoImap: Awaited<ReturnType<typeof startFakeImap>> | null = null;
let demoTwoWay: Awaited<ReturnType<typeof startFakeImap>> | null = null;
const demoFolder = (count: number, bytes: number, label: string) =>
	Array.from({ length: count }, (_, index) => ({ raw: sampleMessage(index + 1, { subject: `${label} ${index + 1}` }), size: bytes }));


/** A fake Gmail for the compact-labels shot: a fake IMAP server on 127.0.0.1 and an account connected to it. */
let demoGmail: Awaited<ReturnType<typeof startFakeImap>> | null = null;
const GMAIL_ADDRESS = "demo.gmail@example.test";
const GMAIL_MAIL = [
	["Priya Raman", "priya@acme.test", "Quarterly support metrics", "First-response time dropped to 42 minutes."],
	["Wingtip Toys", "orders@wingtip.test", "Your order #4821 has shipped", "Your order should arrive on Thursday."],
	["Tom Okafor", "tom@adventure-works.test", "Offsite agenda and travel details", "The offsite is on 14-15 November."],
] as const;

/** The demo admin's All mailboxes view with mail through a connected account; once, so a kept server is not doubled. */
async function seedCompactLabelsDemo(): Promise<void> {
	const api = await apiContext(STORAGE_STATE);
	await turnScreenerOff(api);
	const { mailboxes } = (await (await api.get("/api/mailboxes")).json()) as {
		mailboxes: { id: string; localPart: string; hostname: string; permission?: string }[];
	};
	const home = mailboxes.find((box) => box.localPart === "support") ?? mailboxes[0]!;
	const connected = (await (await api.get("/api/external-accounts")).json()) as { accounts: { address: string }[] };
	if (!connected.accounts.some((account) => account.address === GMAIL_ADDRESS)) {
		demoGmail = await startFakeImap({ authPlain: true, users: { [GMAIL_ADDRESS]: "app-password" }, folders: { INBOX: [] } });
		const response = await api.post("/api/external-accounts", {
			data: {
				address: GMAIL_ADDRESS,
				label: "Gmail",
				preset: "other",
				mailboxId: home.id,
				imap: { host: "127.0.0.1", port: demoGmail.port, security: "starttls" },
				password: "app-password",
				kitePassword: ADMIN.password,
			},
		});
		expect(response.status(), await response.text()).toBe(201);
		const { account } = (await response.json()) as { account: { id: string } };
		GMAIL_MAIL.forEach(([name, from, subject, body], index) =>
			demoGmail!.addMessage(
				"INBOX",
				[
					`From: ${name} <${from}>`,
					`To: ${GMAIL_ADDRESS}`,
					`Subject: ${subject}`,
					`Message-ID: <demo-label-${index}@gmail.example.test>`,
					`Date: Tue, 3 Nov 2026 0${8 + index}:15:00 +0000`,
					"Content-Type: text/plain; charset=utf-8",
					"",
					body,
					"",
				].join("\r\n"),
			),
		);
		await expect
			.poll(async () => (await api.post(`/api/external-accounts/${account.id}/sync`)).status(), { timeout: 120_000, intervals: [5_000] })
			.toBe(202);
		await waitForMessage(api, GMAIL_MAIL[2][2]);
	}
	for (const [localPart, from, name, subject] of [
		["hello", "sofia@northwind.test", "Sofia Marchetti", "Partnership question from the studio"],
		["team", "daniel@northwind.test", "Daniel Osei", "Sprint review notes for Friday"],
	] as const) {
		const box = mailboxes.find((item) => item.localPart === localPart);
		if (!box) continue;
		const probe = await api.get(`/api/messages?${new URLSearchParams({ q: subject, limit: "1" })}`);
		const { messages } = (await probe.json()) as { messages: unknown[] };
		if (messages.length > 0) continue;
		await postInbound(api, { from: `"${name}" <${from}>`, to: `${localPart}@${box.hostname}`, subject, text: subject });
		await waitForMessage(api, subject);
	}
	await api.dispose();
}

/** A model for the shots that need the assistant: nothing it answers appears in them. */
let demoModel: { fake: FakeModel; restore: () => Promise<void> } | null = null;

async function openThaiMail(page: Page) {
	if (!demoModel) {
		const api = await apiContext(STORAGE_STATE);
		const fake = await startFakeModel();
		demoModel = { fake, restore: await connectFakeProvider(api, fake) };
	}
	await seedThaiMail();
	await page.goto("/inbox");
	await page.getByRole("main").getByText(THAI_MAIL.subject, { exact: true }).first().click();
	await expect(page.getByTestId("translation-bar")).toContainText("This message is in Thai.");
}

const SHOTS: Shot[] = [
	{
		// All mailboxes with compact labels: a square per mailbox, a link icon for mail through a connected account, and
		// the account as a view in the sidebar.
		name: "2026-11-06-compact-labels-light",
		theme: "light",
		viewport: { width: 1280, height: 1000 },
		open: async (page) => {
			await seedCompactLabelsDemo();
			await page.addInitScript(() => localStorage.setItem("kite-all-mailboxes", "true"));
			await page.goto("/inbox");
			const rows = page.getByRole("list", { name: "Inbox" }).locator("[data-message-row]");
			await expect(rows.filter({ hasText: "Offsite agenda and travel details" }).locator("[data-via-account]")).toBeVisible();
			await expect(page.getByTestId("kite-sidebar-panel").getByRole("link", { name: "Gmail" })).toBeVisible();
			// An open message shows the reader beside the list, with its full via chip.
			await rows.filter({ hasText: "Offsite agenda and travel details" }).first().getByRole("link").first().click();
			await expect(page.getByRole("button", { name: /^via Gmail: show all mail through/ })).toBeVisible();
			return page;
		},
	},
	{
		// A connected Gmail account with Recheck authentication already finished (demo-mocks: a real Gmail sign-in
		// needs credentials this sandbox never has).
		name: "2026-11-08-connected-account-auth-recheck-light",
		theme: "light",
		viewport: { width: 1040, height: 700 },
		open: async (page) => {
			await mockConnectedAccountAuthRecheck(page);
			await page.goto("/settings/connected-accounts");
			const row = page.locator("[data-external-account]");
			await expect(row.getByRole("button", { name: "Recheck authentication" })).toBeVisible();
			await expect(row.locator("[data-auth-recheck-status]")).toContainText("found a result for 12 of 214 messages");
			return row;
		},
	},
	{
		// The For you page with the hover preview of a reply suggestion open (demo suggestions and texts from demo-mocks).
		name: "2026-11-06-for-you-preview-light",
		theme: "light",
		viewport: { width: 1280, height: 900 },
		open: async (page) => {
			await mockForYouPreview(page, await mockForYou(page));
			await page.goto("/for-you");
			const row = page.locator("[data-for-you-entry]").nth(2);
			await row.hover({ position: { x: 14, y: 10 } });
			const preview = page.locator("[data-suggestion-preview-popover]");
			await expect(preview.locator("[data-preview-block]")).toBeVisible();
			await expect(preview.getByTestId("suggestion-preview-draft")).toBeVisible();
			return page;
		},
	},
	{
		// The home view with nothing open: the For you card with the newest suggestions (demo suggestions from demo-mocks).
		name: "2026-11-06-command-center-for-you-light",
		theme: "light",
		viewport: { width: 1280, height: 900 },
		open: async (page) => {
			await mockForYou(page);
			await page.goto("/inbox");
			const card = page.getByTestId("command-center-for-you");
			await expect(card.locator("[data-for-you-card-entry]")).toHaveCount(4);
			return page.getByTestId("reading-pane-empty");
		},
	},
	{
		// The quiet bar above a message in a language the reader does not read.
		name: "2026-11-06-translate-message-light",
		theme: "light",
		viewport: { width: 1280, height: 700 },
		open: async (page) => {
			await openThaiMail(page);
			return page.locator("[data-reader-scroll]");
		},
	},
	{
		// The same message translated, with an answer written here so the picture reads as real English.
		name: "2026-11-06-translated-message-light",
		theme: "light",
		viewport: { width: 1280, height: 700 },
		open: async (page) => {
			await page.route("**/api/messages/*/translation?*", (route) =>
				route.fulfill({
					json: {
						translation: {
							target: "en",
							sourceLanguage: "th",
							subject: THAI_MAIL_TRANSLATED.subject,
							html: THAI_MAIL_TRANSLATED.html,
							text: null,
							cut: false,
							quotedPending: false,
							model: "demo-model",
						},
					},
				}),
			);
			await openThaiMail(page);
			await page.getByRole("button", { name: "Translate to English" }).click();
			await expect(page.getByTestId("translation-bar")).toContainText("Translated from Thai");
			await expect(page.frameLocator('iframe[title="Message body"]').last().getByText("Bangkok")).toBeVisible();
			return page.locator("[data-reader-scroll]");
		},
	},
	{
		// Settings → Connected accounts → Two-way sync: the choices per direction, with a demo account at the fake server.
		name: "2026-11-06-two-way-sync-light",
		theme: "light",
		viewport: { width: 1100, height: 1100 },
		open: async (page) => {
			demoTwoWay ??= await startFakeImap({
				authPlain: true,
				specialUse: true,
				move: true,
				uidplus: true,
				users: { "demo.account@example.test": "app-password" },
				folders: { INBOX: [], Trash: [], Junk: [], Archive: [] },
				folderAttributes: { Trash: ["\\Trash"], Junk: ["\\Junk"], Archive: ["\\Archive"] },
			});
			await page.goto("/settings/connected-accounts");
			await page.evaluate(
				async ({ port, kitePassword }) => {
					const { mailboxes } = (await (await fetch("/api/mailboxes")).json()) as { mailboxes: { id: string }[] };
					const response = await fetch("/api/external-accounts", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							address: "demo.account@example.test",
							preset: "other",
							mailboxId: mailboxes[0].id,
							imap: { host: "127.0.0.1", port, security: "starttls" },
							password: "app-password",
							kitePassword,
						}),
					});
					// Connected on an earlier try of this shot is as good.
					if (!response.ok && response.status !== 409) throw new Error(await response.text());
				},
				{ port: demoTwoWay.port, kitePassword: ADMIN.password },
			);
			await page.reload();
			const panel = page.locator('[data-account-two-way="demo.account@example.test"]');
			await panel.getByRole("button", { name: "Two-way sync" }).click();
			const choose = async (name: string, label: string) => {
				await panel.getByRole("combobox", { name, exact: true }).click();
				await page.getByRole("listbox").getByRole("option", { name: label, exact: true }).click();
			};
			await choose("Delete in Kite", "Move to the provider's Trash");
			await choose("Read, unread and star in Kite", "On");
			await choose("Deleted or moved out of the Inbox", "Move to Kite's Trash");
			await expect(panel.getByRole("combobox", { name: "Deleted or moved out of the Inbox" })).toHaveText(/Kite's Trash/);
			return panel;
		},
	},
	{
		// Settings → Import → IMAP → Whole account: each folder's size and the totals the import adds.
		name: "2026-11-05-import-sizes-light",
		theme: "light",
		viewport: { width: 1500, height: 1000 },
		open: async (page) => {
			demoImap ??= await startFakeImap({
				authPlain: true,
				folders: {
					INBOX: demoFolder(480, 38_000, "Inbox"),
					Sent: demoFolder(120, 21_000, "Sent"),
					"Projects/Receipts": demoFolder(64, 52_000, "Receipt"),
				},
			});
			await page.goto("/settings/import");
			await page.locator("#import-source").click();
			await page.getByRole("option", { name: "IMAP", exact: true }).click();
			await page.locator("#imap-security").click();
			await page.getByRole("option", { name: "STARTTLS (port 143)" }).click();
			await page.locator("#imap-host").fill("127.0.0.1");
			await page.locator("#imap-port").fill(String(demoImap.port));
			await page.locator("#imap-username").fill("user@example.test");
			await page.locator("#imap-password").fill("app-password");
			await page.getByRole("button", { name: "Show folders" }).click();
			const table = page.getByRole("table", { name: "Folders to import" });
			await expect(table.locator("tbody tr")).toHaveCount(3);
			await expect(table.locator('[data-size="exact"]')).toHaveCount(3);
			const totals = page.getByTestId("import-size-total");
			await expect(totals.locator('[data-total="database"]')).toBeVisible();
			// Only the folder table and the totals are the subject: hide the sign-in fields.
			await page.evaluate(() => {
				const hide = (selector: string, ancestor: string) =>
					document.querySelector<HTMLElement>(selector)?.closest<HTMLElement>(ancestor)?.style.setProperty("display", "none");
				hide("#imap-host", "div.grid");
				hide("#imap-username", "div.grid");
				hide("#imap-security", "div.space-y-2");
				hide("#imap-mode", "div.space-y-2");
			});
			return page.locator("form").filter({ has: table });
		},
	},
	{
		// Admin overview → Database with two updates waiting (the status is faked, no migration is pending in the demo).
		name: "2026-11-06-update-database-light",
		theme: "light",
		viewport: { width: 1000, height: 900 },
		open: async (page) => {
			await page.route("**/api/admin/migrations", (route) =>
				route.fulfill({
					json: {
						ready: false,
						unknown: [],
						pending: ["0091_add_mailbox_ai_disabled.sql", "0092_add_mailbox_ai_disabled_at.sql"],
					},
				}),
			);
			await page.goto("/admin");
			const panel = page.getByRole("region", { name: "Pending database updates" });
			await expect(panel).toBeVisible();
			await panel.scrollIntoViewIfNeeded();
			return panel;
		},
	},
	{
		// Admin overview → the "Get started" checklist, part done and part not (the state is faked for a clean demo).
		name: "2026-11-07-onboarding-checklist-light",
		theme: "light",
		viewport: { width: 1000, height: 1500 },
		open: async (page) => {
			await page.route("**/api/admin/onboarding-checklist", (route) =>
				route.fulfill({
					json: {
						dismissed: false,
						items: [
							{
								id: "domain",
								title: "Connect a domain",
								detail:
									"Mail for this domain is routed through Cloudflare Email Routing by default, or through Resend, Amazon SES or your own mail server. Every message is checked for spam and an unknown sender's first message is held by the Screener before it reaches the inbox.",
								href: "/domains",
								hrefLabel: "Open Domains",
								docHref: "providers.md",
								docLabel: "Sending and receiving providers",
								done: true,
							},
							{
								id: "mailbox",
								title: "Create a mailbox",
								detail:
									"Each mailbox is its own inbox someone signs in to. A shared mailbox lets several people read and reply from the same address.",
								href: "/mailboxes",
								hrefLabel: "Open Mailboxes",
								done: true,
							},
							{
								id: "invite",
								title: "Invite your team",
								detail: "Add an account for each person who should sign in, then create a mailbox for them.",
								href: "/accounts",
								hrefLabel: "Open Accounts",
								done: false,
							},
							{
								id: "modules",
								title: "Review the modules",
								detail:
									"Calendar, Booking, Email templates, Mail import, Money Watch and Drive can each be turned off for the whole install or for one person. Turning one off hides it; it never deletes its data.",
								href: "/modules",
								hrefLabel: "Open Modules",
								docHref: "modules.md#what-off-does",
								docLabel: "What off does",
								done: false,
							},
							{
								id: "spam",
								title: "Turn on phishing and malware lookups",
								detail:
									"A free abuse.ch key lets Kite check risky links and attachments against the URLhaus and ThreatFox threat lists; those two outside services are the only thing a key sends mail data to. Kite's own spam and phishing filters run either way.",
								href: "/general#threat-lookups",
								hrefLabel: "Open General",
								docHref: "spam-protection.md#urlhaus-and-threatfox-lookups-optional",
								docLabel: "URLhaus and ThreatFox lookups",
								done: false,
							},
							{
								id: "assistant",
								title: "Connect an AI provider",
								detail:
									"Kite's assistant can triage mail, draft replies and find subscriptions once an AI provider is connected and tested. Mail only leaves this install when the assistant is on, and only to the provider chosen here.",
								href: "/agent#ai-provider",
								hrefLabel: "Open Agent",
								docHref: "assistant.md#ai-providers",
								docLabel: "AI providers",
								done: true,
							},
							{
								id: "backups",
								title: "Turn on backups",
								detail: "A daily backup protects the database if something goes wrong. Turn on automatic backups or run one now.",
								href: "/backups",
								hrefLabel: "Open Backups",
								docHref: "operations.md#full-backups",
								docLabel: "Full backups",
								done: true,
							},
							{
								id: "updates",
								title: "Keep the database up to date",
								detail:
									"A release sometimes needs a database update. Apply a pending one so new mail keeps appearing and every page keeps working.",
								href: "/admin#database",
								hrefLabel: "Open the database update",
								done: true,
							},
						],
					},
				}),
			);
			await page.goto("/admin");
			const card = page.getByTestId("onboarding-checklist");
			await expect(card).toBeVisible();
			await expect(card.getByTestId("onboarding-item-updates")).toBeVisible();
			await card.scrollIntoViewIfNeeded();
			return card;
		},
	},
	{
		// Admin → Storage → Cold storage: a mail rule moved to a demo store, Drive's rule on but not run yet.
		name: "2026-11-08-cold-storage-light",
		theme: "light",
		viewport: { width: 1100, height: 1200 },
		open: async (page) => {
			await page.route("**/api/admin/storage/cold", (route) =>
				route.fulfill({
					json: {
						rules: [
							{ objectClass: "mail", afterDays: 180, minBytes: 0, target: "sto_demo", enabled: true, updatedAt: "2026-11-08T00:00:00.000Z" },
							{ objectClass: "drive", afterDays: 365, minBytes: 10_485_760, target: "r2-ia", enabled: true, updatedAt: "2026-11-08T00:00:00.000Z" },
							{ objectClass: "backups", afterDays: 90, minBytes: 0, target: "r2-ia", enabled: false, updatedAt: null },
						],
						jobs: [
							{
								objectClass: "mail",
								status: "completed",
								objectsDone: 482,
								bytesDone: 212_000_000,
								errors: 0,
								lastError: null,
								startedAt: "2026-11-08T02:00:00.000Z",
								finishedAt: "2026-11-08T02:04:00.000Z",
							},
						],
						iaAvailable: true,
					},
				}),
			);
			await page.route("**/api/admin/storage", (route) =>
				route.fulfill({
					json: {
						directUploadsReminder: { show: false, setup: null },
						defaultStore: { id: "default", name: "Cloudflare R2", kind: "r2", directUploads: true },
						stores: [
							{
								id: "sto_demo",
								name: "Backblaze archive",
								provider: "b2",
								endpoint: "s3.us-west-002.backblazeb2.com",
								region: "us-west-002",
								bucket: "kite-archive",
								addressing: "path",
								keyHint: "9f2c",
								sameAsBinding: false,
								status: "ok",
								lastCheckedAt: "2026-11-08T00:00:00.000Z",
								lastError: null,
								source: "database",
								blocked: null,
								usedBy: [],
							},
						],
						routes: [],
						migrations: [],
						usage: {
							mail: { objects: 12_400, bytes: 4_900_000_000 },
							drive: { objects: 860, bytes: 1_800_000_000 },
							backups: { objects: 14, bytes: 2_100_000_000 },
						},
						encryptionReady: true,
						migrationPending: false,
						endpointPolicy: { allowInsecure: false, allowPrivate: false },
						runtime: "workers",
					},
				}),
			);
			await page.goto("/storage");
			const section = page.locator("section", { has: page.getByRole("heading", { name: "Cold storage" }) });
			await expect(section).toBeVisible();
			await expect(section.locator('[data-cold-rule="mail"]').getByRole("status")).toHaveText("Up to date");
			await section.scrollIntoViewIfNeeded();
			return section;
		},
	},
	{
		// Admin → Storage → Stores: the "Delete leftovers" action on a store still holding tracked candidates.
		name: "2026-11-08-delete-leftovers-light",
		theme: "light",
		viewport: { width: 1100, height: 500 },
		open: async (page) => {
			await page.route("**/api/admin/storage/cold", (route) =>
				route.fulfill({ json: { rules: [], jobs: [], iaAvailable: true } }),
			);
			await page.route("**/api/admin/storage", (route) =>
				route.fulfill({
					json: {
						directUploadsReminder: { show: false, setup: null },
						defaultStore: { id: "default", name: "Cloudflare R2", kind: "r2", directUploads: true },
						stores: [
							{
								id: "sto_demo",
								name: "Backblaze archive",
								provider: "b2",
								endpoint: "s3.us-west-002.backblazeb2.com",
								region: "us-west-002",
								bucket: "kite-archive",
								addressing: "path",
								keyHint: "9f2c",
								sameAsBinding: false,
								status: "ok",
								lastCheckedAt: "2026-11-08T00:00:00.000Z",
								lastError: null,
								source: "database",
								blocked: null,
								usedBy: ["mail"],
								leftoverCount: 37,
							},
						],
						routes: [],
						migrations: [],
						usage: {
							mail: { objects: 12_400, bytes: 4_900_000_000 },
							drive: { objects: 860, bytes: 1_800_000_000 },
							backups: { objects: 14, bytes: 2_100_000_000 },
						},
						encryptionReady: true,
						migrationPending: false,
						endpointPolicy: { allowInsecure: false, allowPrivate: false },
						runtime: "workers",
					},
				}),
			);
			await page.goto("/storage");
			const section = page.locator("section", { has: page.getByRole("heading", { name: "Stores" }) });
			await expect(section.getByRole("button", { name: "Delete leftovers (37)" })).toBeVisible();
			await section.scrollIntoViewIfNeeded();
			return section;
		},
	},
	{
		// Settings → Connected accounts → Connect account: Mail goes to → New mailbox for this account.
		name: "2026-11-05-new-mailbox-light",
		theme: "light",
		viewport: { width: 900, height: 1000 },
		open: async (page) => {
			await page.goto("/settings/connected-accounts");
			await page.getByRole("button", { name: "Connect account" }).click();
			const dialog = page.getByRole("dialog", { name: "Connect an account" });
			await dialog.getByLabel("Email address").fill("jane.demo@example.test");
			await dialog.getByLabel("Email address").blur();
			await dialog.locator("#external-mailbox").click();
			await page.getByRole("option", { name: "New mailbox for this account…" }).click();
			await expect(dialog.getByLabel("Mailbox name")).toHaveValue("jane.demo-example");
			return dialog;
		},
	},

	{
		name: "2026-11-02-mobile-tab-bar-light",
		theme: "light",
		viewport: { width: 390, height: 844 },
		open: async (page) => {
			await page.goto("/inbox");
			await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
			await expect(page.getByRole("main").getByText(THREAD[0]!.subject).first()).toBeVisible();
			return page;
		},
	},
	...(["light", "dark"] as const).map(
		(theme): Shot => ({
			name: `2026-11-02-admin-cards-${theme}`,
			theme,
			viewport: { width: 1280, height: 800 },
			open: async (page) => {
				await page.goto("/admin");
				await expect(page.getByTestId("backup-health-card")).toBeVisible();
				const cards = page.locator("#database").locator("xpath=..");
				await cards.scrollIntoViewIfNeeded();
				return cards;
			},
		}),
	),
	...(["light", "dark"] as const).map(
		(theme): Shot => ({
			name: `2026-11-02-account-rows-${theme}`,
			theme,
			viewport: { width: 1280, height: 800 },
			open: async (page) => {
				await page.goto("/accounts");
				await expect(page.getByRole("link", { name: /Demo User/ })).toBeVisible();
				return page.getByRole("main");
			},
		}),
	),
	...(["light", "dark"] as const).map(
		(theme): Shot => ({
			name: `2026-11-02-list-chips-${theme}`,
			theme,
			viewport: { width: 1280, height: 800 },
			open: async (page) => {
				await page.goto("/inbox");
				const chips = page.getByRole("group", { name: "Show" });
				await expect(chips.getByRole("button", { name: "Primary" })).toHaveAttribute("aria-pressed", "true");
				await expect(page.getByRole("main").getByText(THREAD[0]!.subject).first()).toBeVisible();
				return page.getByRole("complementary").filter({ has: chips });
			},
		}),
	),
	...(["light", "dark"] as const).map(
		(theme): Shot => ({
			name: `2026-11-02-drive-empty-${theme}`,
			theme,
			viewport: { width: 1280, height: 800 },
			open: async (page) => {
				await page.goto("/drive/trash");
				await expect(page.getByText("The trash is empty")).toBeVisible();
				return page;
			},
		}),
	),
	...(["light", "dark"] as const).map(
		(theme): Shot => ({
			name: `2026-11-02-calendar-frame-${theme}`,
			theme,
			viewport: { width: 1280, height: 800 },
			open: async (page) => {
				await page.goto("/calendar");
				await expect(page.getByRole("button", { name: "New event" })).toBeVisible();
				await expect(page.getByRole("navigation", { name: "Calendar sections" })).toBeVisible();
				await expect(page.locator("[data-upcoming-events]").getByRole("button").first()).toBeVisible();
				return page;
			},
		}),
	),
	...(["light", "dark"] as const).map(
		(theme): Shot => ({
			name: `2026-11-02-drive-frame-${theme}`,
			theme,
			viewport: { width: 1280, height: 800 },
			open: async (page) => {
				await page.goto("/drive");
				await expect(page.getByRole("complementary", { name: "Drive menu" })).toBeVisible();
				await expect(page.locator("[data-drive-item]").first()).toBeVisible();
				return page;
			},
		}),
	),
	...(["light", "dark"] as const).map(
		(theme): Shot => ({
			name: `2026-11-02-fold-two-panes-${theme}`,
			theme,
			viewport: { width: 884, height: 1104 },
			open: async (page) => {
				// The "two" override forces the unfolded layout, the same panes an unfolded foldable shows.
				await page.addInitScript(() => {
					localStorage.setItem("kite-fold-layout", "two");
				});
				await page.goto("/inbox");
				await expect(page.locator("html")).toHaveAttribute("data-fold-posture", "unfolded");
				await page
					.getByRole("main")
					.getByText(THREAD[0]!.subject, { exact: true })
					.first()
					.click();
				await expect(page.getByRole("heading", { level: 1, name: THREAD[0]!.subject })).toBeVisible();
				const list = page.getByRole("main").locator("[data-density]");
				await expect(list.getByText(THREAD[0]!.subject, { exact: true })).toBeVisible();
				return page;
			},
		}),
	),
	{
		// The public home page for a visitor: the mailbox whose emails are the page's content, with the Welcome email open.
		name: "2026-11-02-home-page",
		viewport: { width: 1440, height: 900 },
		open: async (page) => {
			await page.context().clearCookies();
			await page.goto("/");
			await page.locator('[data-hydrated="true"]').waitFor();
			await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
			await expect(page.getByRole("banner").getByRole("link", { name: "Sign in" })).toBeVisible();
			return page;
		},
	},
	{
		// The home page's Inbox with its invented example mails, one open with the drafted-reply suggestion.
		name: "2026-11-03-home-examples",
		viewport: { width: 1440, height: 900 },
		open: async (page) => {
			await page.context().clearCookies();
			await page.goto("/#sample-launch-plan");
			await page.locator('[data-hydrated="true"]').waitFor();
			await expect(page.getByText("Suggestion, nothing sent")).toBeVisible();
			return page;
		},
	},
	...(["light", "dark"] as const).map(
		(theme): Shot => ({
			name: `2026-11-04-rtl-composer-${theme}`,
			theme,
			viewport: { width: 1280, height: 800 },
			open: async (page) => {
				await page.goto("/inbox");
				await page.getByRole("button", { name: "Compose" }).click();
				const to = page.getByLabel("To", { exact: true });
				await to.fill("lena@contoso.test");
				await to.press("Enter");
				await page.getByLabel("Subject").fill("ملاحظات مراجعة التصميم");
				const body = page.getByRole("textbox", { name: "Message body" });
				await body.click();
				await body.pressSequentially("شكرًا ليلى على الملاحظات، سأرسل النسخة الجديدة غدًا.");
				await page.keyboard.press("Enter");
				await body.pressSequentially("Thanks Lena, the new version follows tomorrow.");
				await expect(body.locator("> div")).toHaveCount(2);
				return page.locator("form").filter({ has: page.getByRole("button", { name: "Close composer" }) });
			},
		}),
	),
	...(["light", "dark"] as const).map(
		(theme): Shot => ({
			name: `2026-11-04-rtl-message-${theme}`,
			theme,
			viewport: { width: 1280, height: 800 },
			open: async (page) => {
				await seedRtlMail();
				await page.goto("/inbox");
				await page.getByRole("main").getByText(RTL_MAIL[0]!.subject, { exact: true }).first().click();
				await expect(page.getByRole("heading", { level: 1, name: RTL_MAIL[0]!.subject })).toBeVisible();
				await expect(page.frameLocator('iframe[title="Message body"]').getByText("مرحباً،")).toBeVisible();
				return page;
			},
		}),
	),
	...(["light", "dark"] as const).map(
		(theme): Shot => ({
			name: `2026-11-04-rtl-interface-${theme}`,
			theme,
			viewport: { width: 1280, height: 800 },
			open: async (page) => {
				await page.addInitScript(() => {
					localStorage.setItem("kite-layout-sync", "off");
					localStorage.setItem("kite-interface-direction", "rtl");
				});
				await seedRtlMail();
				await page.goto("/inbox");
				await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
				await page.getByRole("main").getByText(RTL_MAIL[0]!.subject, { exact: true }).first().click();
				await expect(page.frameLocator('iframe[title="Message body"]').getByText("مرحباً،")).toBeVisible();
				return page;
			},
		}),
	),
	{
		name: "2026-11-02-whats-new-images",
		viewport: { width: 1100, height: 760 },
		open: async (page) => {
			await page.goto("/inbox");
			await page.getByRole("button", { name: /^Updated / }).click();
			const dialog = page.getByRole("dialog", { name: /What's new in Kite/ });
			await dialog
				.getByRole("navigation", { name: "Releases" })
				.getByRole("button", { name: /^2026\.11\.01\.2/ })
				.click();
			const thumbnail = dialog.getByRole("button", { name: /command center in light mode/i });
			await thumbnail.scrollIntoViewIfNeeded();
			await expect(thumbnail).toBeVisible();
			await expect.poll(() => dialog.locator("img").evaluateAll((images) => images.every((image) => (image as HTMLImageElement).complete))).toBe(true);
			return dialog;
		},
	},
	{
		// The pager shares a row with the first section label of the Inbox list beside an open message.
		name: "2026-11-05-list-pager-inline",
		viewport: { width: 1280, height: 800 },
		open: async (page) => {
			await seedPagedMail();
			await page.goto("/inbox");
			await page.getByRole("main").getByText("Weekly digest 24", { exact: true }).first().click();
			await expect(page.getByRole("heading", { level: 1, name: "Weekly digest 24" })).toBeVisible();
			await expect(page.getByRole("button", { name: "Next page" })).toBeVisible();
			return page;
		},
	},
	...(
		[
			["2026-11-06-interface-dutch", "nl", "Accountmenu openen"],
			["2026-11-06-interface-arabic", "ar", null],
		] as const
	).map(
		([name, language, accountMenu]): Shot => ({
			// The shell in a translated language: Dutch with the account menu open on Language, Arabic showing the mirror.
			name,
			theme: "light",
			viewport: { width: 1280, height: 860 },
			open: async (page) => {
				await seedDemoData();
				await page.addInitScript(
					(value) => {
						localStorage.setItem("kite-layout-sync", "off");
						localStorage.setItem("kite-interface-language", value);
					},
					language,
				);
				await page.goto("/inbox");
				await expect(page.locator("#kite-sidebar-panel")).toBeVisible();
				await expect(page.locator("[data-message-row]").first()).toBeVisible();
				if (accountMenu) {
					await page.getByRole("button", { name: accountMenu }).click();
					await expect(page.getByRole("radiogroup").last()).toBeVisible();
				}
				return page;
			},
		}),
	),
	{
		// Money Watch's Payments tab: invented receipts, an invoice and a refund with month totals per currency. Before the
		// No AI shot, which turns AI off for the mailbox these are delivered to.
		name: "2026-11-07-money-watch-payments-light",
		theme: "light",
		viewport: { width: 1280, height: 900 },
		open: async (page) => {
			await seedPaymentsDemo();
			await page.goto("/finance?tab=payments");
			await expect(page.locator("[data-payment-row]").first()).toBeVisible();
			await expect(page.locator("[data-payment-month]").first()).toBeVisible();
			return page.locator("[data-finance-page]");
		},
	},
	{
		// Scan last 90 days partway through: the status line's own progress, over the real seeded rows (the scan status
		// itself is faked, since a real scan of this little demo mail finishes before a screenshot could catch it running).
		name: "2026-11-08-money-watch-scan-progress-light",
		theme: "light",
		viewport: { width: 1280, height: 900 },
		open: async (page) => {
			await seedPaymentsDemo();
			await page.route("**/api/finance/payments", async (route) => {
				const response = await route.fetch();
				const data = (await response.json()) as object;
				await route.fulfill({
					response,
					json: { ...data, scan: { status: "running", scanned: 42, recorded: 3, skipped: 0 } },
				});
			});
			await page.goto("/finance?tab=payments");
			await expect(page.locator("[data-payment-scan-status]")).toContainText("Scanning the last 90 days");
			return page.locator("[data-finance-page]");
		},
	},
	{
		// The assistant panel's settings: No AI for this mailbox, turned on (it stays on in the e2e state afterwards).
		name: "2026-11-05-mailbox-no-ai",
		viewport: { width: 1280, height: 900 },
		open: async (page) => {
			await page.goto("/inbox");
			const toggle = page.getByRole("button", { name: /^(Open|Close) email assistant$/ });
			await expect(toggle).toBeVisible();
			if ((await toggle.getAttribute("aria-label")) === "Open email assistant") await toggle.click({ timeout: 45_000 });
			const panel = page.locator("#email-assistant-panel");
			await panel.getByRole("button", { name: "Assistant settings" }).click();
			const toggleAi = panel.getByRole("switch", { name: /^No AI for / });
			await expect(toggleAi).toBeEnabled();
			if ((await toggleAi.getAttribute("aria-checked")) !== "true") {
				await toggleAi.click();
				await page.getByRole("button", { name: "Turn off AI" }).click();
			}
			await expect(toggleAi).toBeChecked();
			return panel.getByTestId("mailbox-ai-setting");
		},
	},
	{
		// The assistant panel when no AI provider is configured at all: a notice instead of a silent, broken chat.
		name: "2026-11-08-no-provider-notice-light",
		viewport: { width: 1280, height: 900 },
		open: async (page) => {
			await page.route("**/api/agent/settings?*", (route) =>
				route.fulfill({
					json: {
						settings: {
							mailboxId: "demo",
							enabled: true,
							modelId: "demo",
							autoDraftEnabled: false,
							reviewerUserId: null,
							instructions: "",
							dailyLimit: 5,
						},
						models: ["demo"],
						canManage: true,
						providerConfigured: false,
						externalProviderBlocked: false,
						providerLabel: "",
						autoReplyEnabled: false,
						reviewers: [],
					},
				}),
			);
			await page.goto("/inbox");
			const toggle = page.getByRole("button", { name: /^(Open|Close) email assistant$/ });
			await expect(toggle).toBeVisible();
			if ((await toggle.getAttribute("aria-label")) === "Open email assistant") await toggle.click({ timeout: 45_000 });
			const panel = page.locator("#email-assistant-panel");
			await expect(panel.getByTestId("no-provider-notice")).toBeVisible();
			return panel;
		},
	},
	...(["dark"] as const).map(
		(theme): Shot => ({
			// A file dragged over the floating composer: the drop target stays up while the drag is held.
			name: `2026-11-07-composer-drop-target-${theme}`,
			theme,
			viewport: { width: 1280, height: 800 },
			open: async (page) => {
				await page.goto("/inbox");
				await page.getByRole("button", { name: "Compose" }).click();
				const to = page.getByLabel("To", { exact: true });
				await to.fill("lena@contoso.test");
				await to.press("Enter");
				await page.getByLabel("Subject").fill("Agenda for Thursday");
				const body = page.getByRole("textbox", { name: "Message body" });
				await body.fill("Hi Lena, the agenda is attached.");
				const box = await body.boundingBox();
				if (!box) throw new Error("the message body has no box");
				const dragged = path.join(process.cwd(), "test-results", "agenda.pdf");
				mkdirSync(path.dirname(dragged), { recursive: true });
				writeFileSync(dragged, "%PDF-1.4\n");
				const cdp = await page.context().newCDPSession(page);
				for (const type of ["dragEnter", "dragOver"] as const) {
					await cdp.send("Input.dispatchDragEvent", {
						type,
						x: box.x + box.width / 2,
						y: box.y + box.height / 2,
						data: { items: [], files: [dragged], dragOperationsMask: 1 },
					});
				}
				await expect(page.getByText("Drop files to attach")).toBeVisible();
				return page.locator("form").filter({ has: page.getByRole("button", { name: "Close composer" }) });
			},
		}),
	),
	{
		// The mailbox tour's Screener step, as a teammate (not the owner) would see it on their first login.
		name: "2026-11-08-mailbox-tour-light",
		theme: "light",
		viewport: { width: 1280, height: 800 },
		open: async (page) => {
			// Demo data has one account, the owner: the tour is for everyone else, so the shot borrows their
			// session and only pretends it is not the owner, the one thing the tour's own code checks.
			await page.route("**/api/auth/me", async (route) => {
				const response = await route.fetch();
				const body = (await response.json()) as { user: { isPrimaryAdmin: boolean } };
				body.user.isPrimaryAdmin = false;
				await route.fulfill({ response, json: body });
			});
			await page.goto("/inbox");
			const dialog = page.getByTestId("mailbox-tour");
			await expect(dialog).toBeVisible();
			await dialog.getByRole("button", { name: "Next" }).click();
			await expect(dialog.getByText("The first time someone new writes to you")).toBeVisible();
			return dialog;
		},
	},
];

async function openPage(browser: Browser, { theme = "light", viewport }: Shot) {
	const context = await browser.newContext({
		storageState: STORAGE_STATE,
		viewport: viewport ?? { width: 1280, height: 800 },
		colorScheme: theme,
	});
	await context.addInitScript((nextTheme) => {
		localStorage.removeItem("kite-style");
		localStorage.setItem("kite-theme", nextTheme);
	}, theme);
	return context.newPage();
}

/** WebP at the best quality that stays under the size limit, at most MAX_WIDTH wide. */
async function toWebp(png: Buffer): Promise<Buffer> {
	for (const quality of [82, 74, 66, 58, 50]) {
		const webp = await sharp(png).resize({ width: MAX_WIDTH, withoutEnlargement: true }).webp({ quality }).toBuffer();
		if (webp.length <= MAX_BYTES) return webp;
	}
	throw new Error("The screenshot does not fit in 200 KB; crop it to the relevant part");
}

test.describe("changelog screenshots", () => {
	test.skip(!RECORD, "Set KITE_CHANGELOG_SHOTS=1 (npm run changelog:screenshot) to take them");
	test.beforeAll(seedDemoData);
	test.afterAll(async () => {
		await demoImap?.close();
		demoImap = null;
		await demoGmail?.close();
		demoGmail = null;
		await demoModel?.restore();
		await demoModel?.fake.close();
		demoModel = null;
		await demoTwoWay?.close();
		demoTwoWay = null;
	});

	for (const shot of SHOTS) {
		test(shot.name, async ({ browser }) => {
			const page = await openPage(browser, shot);
			const target = await shot.open(page);
			await page.waitForLoadState("networkidle");
			await page.evaluate(() => document.fonts.ready);
			const png = await target.screenshot({ animations: "disabled", caret: "hide" });
			mkdirSync(OUT_DIR, { recursive: true });
			writeFileSync(path.join(OUT_DIR, `${shot.name}.webp`), await toWebp(png));
			await page.context().close();
		});
	}
});
