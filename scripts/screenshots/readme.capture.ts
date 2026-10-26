import { expect, test, type Browser, type Page } from "@playwright/test";
import { SUPPORT_ADDRESS, STORAGE_STATE } from "../../e2e/support/constants";
import { openMessage } from "../../e2e/support/helpers";
import { OPENED, seedDemoData } from "./demo-data";

test.describe.configure({ mode: "serial" });

test.beforeAll(seedDemoData);

type Appearance = { style?: string; theme?: string; phone?: boolean };

async function open(browser: Browser, { style = "kite", theme = "light", phone = false }: Appearance = {}) {
	const context = await browser.newContext({
		storageState: STORAGE_STATE,
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

async function capture(page: Page, name: string) {
	// A visible loading overlay, if the page has one, must be gone.
	await expect(page.locator('[aria-label="Loading"].opacity-100')).toHaveCount(0);
	await expect(page.getByRole("progressbar", { name: "Loading page" })).toHaveCount(0);
	await page.waitForLoadState("networkidle");
	await page.evaluate(() => document.fonts.ready);
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
		await openLenasMessage(page);
		await capture(page, name);
	});
}

test("compose", async ({ browser }) => {
	const page = await open(browser);
	await openLenasMessage(page);
	await page.getByRole("button", { name: "Reply (r)" }).click();
	await page
		.getByRole("textbox", { name: "Message body" })
		.fill(
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
