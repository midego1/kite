import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";
import sharp from "sharp";
import { ADMIN, STORAGE_STATE } from "../../e2e/support/constants";
import { apiContext, postInbound, waitForMessage } from "../../e2e/support/helpers";
import { turnScreenerOff } from "../../e2e/support/screener";
import { RTL_MAIL, seedDemoData, seedPagedMail, seedRtlMail, THREAD } from "./demo-data";
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

const SHOTS: Shot[] = [
	{
		// All mailboxes with compact labels: a dot per mailbox, a link icon for mail through a connected account, and
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
