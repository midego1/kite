import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";
import sharp from "sharp";
import { STORAGE_STATE, SUPPORT_ADDRESS } from "../../e2e/support/constants";
import { apiContext, openMessage } from "../../e2e/support/helpers";
import { OPENED, THREAD, seedDemoData } from "./demo-data";
import { mockAiUsage, mockAssistant, mockForYou } from "./demo-mocks";

// The README screenshots: every feature once in light and once in dark, in the default "Zero" look, as
// screenshots/<name>-light.webp and screenshots/<name>-dark.webp (the README picks one per reader with <picture>).
// Desktop shots are a 1440x900 window at 2x; the phone shot is 390x844 at 2x.
test.beforeAll(seedDemoData);

// Opening a message marks it read, so without this the dark shot of a pair would show fewer unread messages
// than its light partner, which ran first. Every test starts from the same state: everything unread.
test.beforeEach(async () => {
	const api = await apiContext(STORAGE_STATE);
	const { mailboxes } = (await (await api.get("/api/mailboxes")).json()) as {
		mailboxes: { id: string; address?: string; email?: string }[];
	};
	const mailbox = mailboxes.find((item) => (item.address ?? item.email) === SUPPORT_ADDRESS) ?? mailboxes[0]!;
	const listed = await api.get(`/api/messages?${new URLSearchParams({ mailboxId: mailbox.id, status: "received", limit: "100" })}`);
	expect(listed.ok(), await listed.text()).toBe(true);
	const { messages } = (await listed.json()) as { messages: { id: string }[] };
	const marked = await api.post("/api/messages/bulk", {
		data: { messageIds: messages.map((message) => message.id), action: "unread" },
	});
	expect(marked.ok(), await marked.text()).toBe(true);
	await api.dispose();
});

type Theme = "light" | "dark";
const THEMES: Theme[] = ["light", "dark"];

/** Whether the page's own session check (`/api/auth/me`, which the app gives 5 s and never retries) has failed. */
const sessionCheck = new WeakMap<Page, { failed: boolean }>();

async function open(browser: Browser, theme: Theme, phone = false) {
	const context = await browser.newContext({
		storageState: STORAGE_STATE,
		viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 },
		deviceScaleFactor: 2,
		...(phone ? { isMobile: true, hasTouch: true } : {}),
		colorScheme: theme,
	});
	await context.addInitScript((appearance) => {
		// The default look is the Zero one; saving "kite" would be the same as saving nothing.
		localStorage.removeItem("kite-style");
		localStorage.setItem("kite-theme", appearance);
	}, theme);
	const page = await context.newPage();
	const check = { failed: false };
	sessionCheck.set(page, check);
	page.on("requestfailed", (request) => {
		if (request.url().includes("/api/auth/me")) check.failed = true;
	});
	// The demo install has no sending provider, so Admin would show an "Operational alerts" notice in every shot.
	await page.route("**/api/admin/alerts/active", (route) =>
		route.fulfill({ json: { enabled: false, alerts: [], signature: null } }),
	);
	return page;
}

async function openLenasMessage(page: Page) {
	await page.goto("/inbox");
	await openMessage(page, OPENED.subject);
	const body = page.locator("iframe").first();
	await expect(body.contentFrame().getByText(/Happy to pair/)).toBeAttached();
	// The frame sizes itself to its document after it renders; a shot taken earlier cuts the body off.
	await expect
		.poll(() =>
			body.evaluate((frame: HTMLIFrameElement) => {
				const root = frame.contentDocument?.documentElement;
				return !!root && root.scrollHeight > 0 && frame.contentWindow!.innerHeight >= root.scrollHeight;
			}),
		)
		.toBe(true);
}

/** Opens the three-message thread with every earlier message unfolded, as the reader shows a conversation. */
async function openThread(page: Page) {
	await page.goto("/inbox");
	await openMessage(page, `Re: ${THREAD[0]!.subject}`);
	await expect(page.getByRole("list", { name: "Participants" })).toBeVisible();
	await page.waitForLoadState("networkidle");
	const earlier = page.getByRole("region", { name: "Earlier messages in this conversation" });
	// The thread can re-render once its read state settles, folding the cards again; unfold until every body shows.
	await expect(async () => {
		await page.keyboard.press("Escape");
		// Each card's own toggle; its "More actions" menu trigger also reports aria-expanded but carries a label.
		const folded = earlier.locator('button[aria-expanded="false"]:not([aria-label])');
		while ((await folded.count()) > 0) await folded.first().click();
		await expect(page.locator("iframe")).toHaveCount(THREAD.length, { timeout: 3000 });
	}).toPass({ timeout: 60_000 });
	// Off the list, so no row shows its hover actions.
	await page.mouse.move(1000, 860);
}

/**
 * Opens a page that depends on who is signed in (menus, avatars) and waits for `ready`. On a slow machine the
 * session check can time out and the app then shows the signed-out menus for good, so reload until it succeeds.
 */
async function visit(page: Page, path: string, ready: Locator) {
	const check = sessionCheck.get(page)!;
	await page.goto(path);
	await expect(async () => {
		if (check.failed) {
			check.failed = false;
			await page.reload();
		}
		await expect(ready).toBeVisible({ timeout: 30_000 });
		await expect(page.getByText(SUPPORT_ADDRESS).first()).toBeVisible({ timeout: 30_000 });
		// The session check is one of the requests that must have settled by now, and answered.
		await page.waitForLoadState("networkidle");
		expect(check.failed, "the session check answered").toBe(false);
	}).toPass({ timeout: 300_000, intervals: [1000] });
}

/**
 * Takes the shot once the page is settled. `rail` is whether the mailbox rail (with its "Add mailbox" button, which
 * only appears once the session check has answered) is on screen; a shot taken before it completes is not used.
 * `unread` is whether the sidebar's Inbox item shows its unread count, which arrives with the message counts.
 */
async function capture(page: Page, name: string, theme: Theme, { rail = true, unread = rail } = {}) {
	// Playwright's click retries can leave the message list scrolled a little; shots start at its top.
	await page.evaluate(() => {
		for (const list of document.querySelectorAll("[data-density]")) list.scrollTop = 0;
	});
	// A visible loading overlay, if the page has one, must be gone.
	await expect(page.locator('[aria-label="Loading"].opacity-100')).toHaveCount(0);
	await expect(page.getByRole("progressbar", { name: "Loading page" })).toHaveCount(0);
	if (rail) await expect(page.getByRole("button", { name: "Add mailbox" })).toBeVisible();
	if (unread) await expect(page.getByRole("link", { name: /^Inbox\s*\d+$/ }).first()).toBeVisible();
	expect(sessionCheck.get(page)!.failed, "the session check failed, so the sidebar is incomplete").toBe(false);
	// The first-load splash fades out over 300 ms after the page has its data.
	await expect(page.locator("[data-loading-overlay]")).toHaveCSS("opacity", "0");
	await page.waitForLoadState("networkidle");
	await page.evaluate(() => document.fonts.ready);
	// The shots must use the app's own font, not a system fallback.
	const uiFontLoaded = await page.evaluate(() => {
		const family = getComputedStyle(document.body).fontFamily.split(",")[0].trim().replace(/["']/g, "");
		return [...document.fonts].some((face) => face.family.replace(/["']/g, "") === family && face.status === "loaded");
	});
	expect(uiFontLoaded, "the UI font is loaded").toBe(true);
	// Light and dark are what the README asks for; the Zero look must be the one on screen.
	await expect(page.locator("html")).toHaveAttribute("data-style", "kite");
	await expect(page.locator("html")).toHaveClass(new RegExp(`(^| )${theme}( |$)`));
	const png = await page.screenshot({ animations: "disabled", caret: "hide", type: "png" });
	// Lossy WebP keeps a 2x shot of a text-heavy window near 150 KB where the PNG is over 1 MB; GitHub renders it.
	await sharp(png).webp({ quality: 82, effort: 6, smartSubsample: true }).toFile(`screenshots/${name}-${theme}.webp`);
	await page.context().close();
}

for (const theme of THEMES) {
	test(`inbox (${theme})`, async ({ browser }) => {
		const page = await open(browser, theme);
		await openThread(page);
		await capture(page, "inbox", theme);
	});

	test(`compose (${theme})`, async ({ browser }) => {
		const page = await open(browser, theme);
		await openLenasMessage(page);
		await page.getByRole("button", { name: "Reply (r)" }).click();
		const body = page.getByRole("textbox", { name: "Message body" });
		// The editor stays read-only until the reply draft has loaded.
		await expect(body).toHaveAttribute("contenteditable", "true");
		await body.fill(
			"Hi Lena,\n\nThanks for the notes. Suggesting hello@ and support@ is a great idea, I'll add it to the mailbox step. Does Thursday afternoon work to pair on the welcome email?\n\nBest,\nDemo",
		);
		await capture(page, "compose", theme);
	});

	test(`assistant (${theme})`, async ({ browser }) => {
		const page = await open(browser, theme);
		await mockAssistant(page);
		await openLenasMessage(page);
		const toggle = page.getByRole("button", { name: /^(Open|Close) Kite AI$/ }).first();
		await expect(toggle).toBeVisible();
		if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
		const panel = page.getByRole("region", { name: "Email assistant" });
		await panel.getByLabel("Previous chats").click();
		await panel.getByRole("button", { name: "Replying to Lena", exact: true }).click();
		const draft = panel.getByRole("region", { name: "Reply draft" });
		await expect(draft.getByRole("button", { name: "Approve to send" })).toBeInViewport();
		await expect(panel.getByRole("textbox", { name: "Message Kite AI" })).toBeEnabled();
		await capture(page, "assistant", theme);
	});

	test(`for you (${theme})`, async ({ browser }) => {
		const page = await open(browser, theme);
		await mockForYou(page);
		await visit(page, "/for-you", page.getByText("Possible phishing"));
		await capture(page, "for-you", theme);
	});

	test(`calendar (${theme})`, async ({ browser }) => {
		const page = await open(browser, theme);
		await page.goto("/calendar");
		await expect(page.getByRole("button", { name: /Design review: onboarding/ }).first()).toBeVisible();
		await capture(page, "calendar", theme, { rail: false });
	});

	test(`drive (${theme})`, async ({ browser }) => {
		const page = await open(browser, theme);
		await page.goto("/drive");
		await expect(page.getByText("Launch plan.pdf").first()).toBeVisible();
		await expect(page.getByText("Brand assets").first()).toBeVisible();
		await capture(page, "drive", theme, { unread: false });
	});

	test(`settings (${theme})`, async ({ browser }) => {
		const page = await open(browser, theme);
		await visit(page, "/settings/inbox", page.getByRole("combobox", { name: "Undo send window" }));
		await capture(page, "settings", theme);
	});

	test(`admin (${theme})`, async ({ browser }) => {
		const page = await open(browser, theme);
		await visit(page, "/admin", page.getByText("The database schema is up to date."));
		await capture(page, "admin", theme);
	});

	test(`ai usage (${theme})`, async ({ browser }) => {
		const page = await open(browser, theme);
		await mockAiUsage(page);
		await visit(page, "/ai-usage", page.getByRole("cell", { name: "claude-sonnet-5-5" }).first());
		await capture(page, "ai-usage", theme);
	});

	test(`inbox on a phone (${theme})`, async ({ browser }) => {
		const page = await open(browser, theme, true);
		await openLenasMessage(page);
		await capture(page, "inbox-phone", theme, { rail: false });
	});
}
