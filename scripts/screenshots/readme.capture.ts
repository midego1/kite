import { expect, test, type Browser, type Page } from "@playwright/test";
import { SUPPORT_ADDRESS, STORAGE_STATE } from "../../e2e/support/constants";
import { createFolder, createLink, uploadFile } from "../../e2e/support/drive";
import { apiContext, openMessage } from "../../e2e/support/helpers";
import { OPENED, THREAD, seedDemoData } from "./demo-data";

test.describe.configure({ mode: "serial" });

test.beforeAll(seedDemoData);

type Appearance = { style?: string; theme?: string; phone?: boolean; signedOut?: boolean };

async function open(
	browser: Browser,
	{ style = "kite", theme = "light", phone = false, signedOut = false }: Appearance = {},
) {
	const context = await browser.newContext({
		storageState: signedOut ? { cookies: [], origins: [] } : STORAGE_STATE,
		viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 },
		...(phone ? { deviceScaleFactor: 2, isMobile: true, hasTouch: true } : {}),
		colorScheme: theme === "dark" ? "dark" : "light",
	});
	await context.addInitScript(
		(appearance) => {
			localStorage.setItem("kite-style", appearance.style);
			localStorage.setItem("kite-theme", appearance.theme);
		},
		{ style, theme },
	);
	return context.newPage();
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

async function capture(page: Page, name: string) {
	// Playwright's click retries can leave the message list scrolled a little; shots start at its top.
	await page.evaluate(() => {
		for (const list of document.querySelectorAll("[data-density]")) list.scrollTop = 0;
	});
	// A visible loading overlay, if the page has one, must be gone.
	await expect(page.locator('[aria-label="Loading"].opacity-100')).toHaveCount(0);
	await expect(page.getByRole("progressbar", { name: "Loading page" })).toHaveCount(0);
	await page.waitForLoadState("networkidle");
	await page.evaluate(() => document.fonts.ready);
	// The shots must use the app's own font, not a system fallback.
	const uiFontLoaded = await page.evaluate(() => {
		const family = getComputedStyle(document.body).fontFamily.split(",")[0].trim().replace(/["']/g, "");
		return [...document.fonts].some((face) => face.family.replace(/["']/g, "") === family && face.status === "loaded");
	});
	expect(uiFontLoaded, "the UI font is loaded").toBe(true);
	await page.screenshot({ path: `screenshots/${name}.png`, animations: "disabled", caret: "hide" });
	await page.context().close();
}

for (const [name, appearance] of [
	["inbox", {}],
	["inbox-dark", { theme: "dark" }],
	["inbox-phone", { phone: true }],
] as const) {
	test(name, async ({ browser }) => {
		const page = await open(browser, appearance);
		if (name === "inbox-phone") await openLenasMessage(page);
		else await openThread(page);
		await capture(page, name);
	});
}

test("compose", async ({ browser }) => {
	const page = await open(browser);
	await openLenasMessage(page);
	await page.getByRole("button", { name: "Reply (r)" }).click();
	const body = page.getByRole("textbox", { name: "Message body" });
	// The editor stays read-only until the reply draft has loaded.
	await expect(body).toHaveAttribute("contenteditable", "true");
	await body.fill(
			"Hi Lena,\n\nThanks for the notes. Suggesting hello@ and support@ is a great idea, I'll add it to the mailbox step. Does Thursday afternoon work to pair on the welcome email?\n\nBest,\nDemo",
		);
	await capture(page, "compose");
});

test("domains", async ({ browser }) => {
	const page = await open(browser);
	await page.goto("/domains");
	await page.getByRole("button", { name: "Show details" }).first().click();
	await expect(page.getByRole("main").getByText("example.com").first()).toBeVisible();
	await expect(page.getByRole("main").locator(".animate-pulse")).toHaveCount(0);
	// Opening the details scrolls the page; the shot should start at the page heading.
	await page.evaluate(() => {
		for (const element of document.querySelectorAll("*")) if (element.scrollTop) element.scrollTop = 0;
	});
	await capture(page, "domains");
});

test("mailboxes", async ({ browser }) => {
	const page = await open(browser);
	await page.goto("/mailboxes");
	await expect(page.getByRole("main").getByText(SUPPORT_ADDRESS).first()).toBeVisible();
	await capture(page, "mailboxes");
});

test("calendar", async ({ browser }) => {
	const page = await open(browser);
	await page.goto("/calendar");
	await expect(page.getByRole("button", { name: /Design review: onboarding/ }).first()).toBeVisible();
	await capture(page, "calendar");
});

for (const [name, appearance] of [
	["inbox-list-phone", { phone: true }],
	["inbox-list-phone-dark", { phone: true, theme: "dark" }],
] as const) {
	test(name, async ({ browser }) => {
		const page = await open(browser, appearance);
		await page.goto("/inbox");
		await expect(page.getByText(OPENED.subject).first()).toBeVisible();
		await capture(page, name);
	});
}

for (const [name, appearance] of [
	["settings", {}],
	["settings-dark", { theme: "dark" }],
] as const) {
	test(name, async ({ browser }) => {
		const page = await open(browser, appearance);
		await page.goto("/settings/inbox");
		const undoWindow = page.getByRole("combobox", { name: "Undo send window" });
		await expect(undoWindow).toBeVisible();
		// The sending section holds a switch and a select side by side.
		await undoWindow.scrollIntoViewIfNeeded();
		await capture(page, name);
	});
}

// The pages around the mail: what Kite noticed, subscriptions, files and booking events.
for (const [name, path, ready, appearance] of [
	["for-you", "/for-you", "What Kite noticed in your mail.", {}],
	["for-you-dark", "/for-you", "What Kite noticed in your mail.", { theme: "dark" }],
	["finance", "/finance", "Paid in the last 12 months", {}],
	["finance-dark", "/finance", "Paid in the last 12 months", { theme: "dark" }],
	["drive", "/drive", "My Drive", {}],
	["drive-dark", "/drive", "My Drive", { theme: "dark" }],
	["booking", "/booking", "Set the meetings people can book with you.", {}],
	["booking-dark", "/booking", "Set the meetings people can book with you.", { theme: "dark" }],
] as const) {
	test(name, async ({ browser }) => {
		const page = await open(browser, appearance);
		await page.goto(path);
		await expect(page.getByRole("main").getByText(ready, { exact: false }).first()).toBeVisible();
		await capture(page, `pages/${name}`);
	});
}

// Signed-out pages: sign-in, password reset and not-found.
for (const [name, path, ready, appearance] of [
	["login", "/login", "Forgot password?", { signedOut: true }],
	["login-dark", "/login", "Forgot password?", { signedOut: true, theme: "dark" }],
	["login-phone", "/login", "Forgot password?", { signedOut: true, phone: true }],
	["forgot-password", "/forgot-password", "Send reset link", { signedOut: true }],
	["not-found", "/no-such-page", "Page not found", {}],
	["not-found-dark", "/no-such-page", "Page not found", { theme: "dark" }],
] as const) {
	test(name, async ({ browser }) => {
		const page = await open(browser, appearance);
		await page.goto(path);
		await expect(page.getByText(ready, { exact: false }).first()).toBeVisible();
		await capture(page, `public/${name}`);
	});
}

// What a visitor sees from a booking link and a Drive link.
test("public booking and Drive pages", async ({ browser }) => {
	const setup = await open(browser);
	await setup.goto("/booking");
	const event = setup.locator("article", { hasText: "30 Minute Meeting" });
	await expect(event).toBeVisible();
	const turnOn = event.getByRole("button", { name: "Turn on" });
	if (await turnOn.isVisible()) {
		const saved = setup.waitForResponse((response) => response.url().includes("/api/booking") && response.request().method() !== "GET");
		await turnOn.click();
		await saved;
	}
	await expect(event.getByRole("button", { name: "Turn on" })).toHaveCount(0);
	await setup.context().close();

	const api = await apiContext(STORAGE_STATE);
	const me = (await (await api.get("/api/auth/me")).json()) as { user: { id: string } };
	const booking = (await (await api.get("/api/booking")).json()) as {
		username: string;
		events: { id: string; name: string }[];
	};
	const meeting = booking.events.find((item) => item.name === "30 Minute Meeting")!;
	const folder = await createFolder(api, `Launch kit ${Date.now()}`);
	await uploadFile(api, "launch-plan.txt", "Launch plan", { parentId: folder.id });
	await uploadFile(api, "rollout-checklist.csv", "step,owner", { contentType: "text/csv", parentId: folder.id });
	const { token } = await createLink(api, folder.id);
	const locked = await createLink(api, folder.id, { password: "demo-link-password" });
	await api.dispose();

	for (const [name, path, ready, appearance] of [
		["booking", `/c/${booking.username}`, "30 Minute Meeting", {}],
		["booking-event", `/book/${me.user.id}/${meeting.id}`, "30 Minute Meeting", {}],
		["booking-event-dark", `/book/${me.user.id}/${meeting.id}`, "30 Minute Meeting", { theme: "dark" }],
		["booking-event-phone", `/book/${me.user.id}/${meeting.id}`, "30 Minute Meeting", { phone: true }],
		["drive-link", `/d/${token}`, "launch-plan.txt", {}],
		["drive-link-dark", `/d/${token}`, "launch-plan.txt", { theme: "dark" }],
		["drive-link-password", `/d/${locked.token}`, "This link needs a password", {}],
	] as const) {
		const page = await open(browser, { ...appearance, signedOut: true });
		await page.goto(path);
		// Public pages compile on their first visit in a dev server.
		await expect(page.getByText(ready, { exact: false }).first()).toBeVisible({ timeout: 120_000 });
		await capture(page, `public/${name}`);
	}
});

// A shared dialog with a form.
for (const [name, appearance] of [
	["dialog-new-mailbox", {}],
	["dialog-new-mailbox-dark", { theme: "dark" }],
] as const) {
	test(name, async ({ browser }) => {
		const page = await open(browser, appearance);
		await page.goto("/mailboxes");
		await page.getByRole("button", { name: "New mailbox" }).first().click();
		await expect(page.getByRole("dialog")).toBeVisible();
		await capture(page, `public/${name}`);
	});
}

test("command-palette", async ({ browser }) => {
	const page = await open(browser);
	await page.goto("/inbox");
	await expect(page.getByText(OPENED.subject).first()).toBeVisible();
	const palette = page.getByRole("dialog", { name: "Command palette" });
	// Shortcuts bind once the account's preference has loaded.
	await expect(async () => {
		if (!(await palette.isVisible())) await page.keyboard.press("ControlOrMeta+k");
		await expect(palette).toBeVisible({ timeout: 1000 });
	}).toPass();
	await capture(page, "command-palette");
});

test("inbox-menu-phone", async ({ browser }) => {
	const page = await open(browser, { phone: true });
	await page.goto("/inbox");
	await expect(page.getByText(OPENED.subject).first()).toBeVisible();
	await page.getByRole("button", { name: "Open menu" }).click();
	await expect(page.getByRole("link", { name: /^Inbox\b/ }).first()).toBeVisible();
	await capture(page, "inbox-menu-phone");
});
