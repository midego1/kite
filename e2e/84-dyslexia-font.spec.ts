import { expect, test, type Page } from "@playwright/test";
import { STORAGE_STATE, SUPPORT_ADDRESS } from "./support/constants";
import { apiContext, deliverInbound, openMessage, uniqueToken } from "./support/helpers";
import { chooseOption, expectSelectValue } from "./support/select";

// Settings → Appearance → Font → Dyslexia-friendly (OpenDyslexic): the self-hosted font takes over the app, the
// composer and plain-text mail, HTML mail only with "Font in HTML emails", it is preloaded before paint on the
// next load, and while it is not chosen no font file is requested at all.

const FONT = "Dyslexia-friendly (OpenDyslexic)";
const DEFAULT_FONT = "Match style";
let htmlSubject: string;
let textSubject: string;

test.beforeAll(async () => {
	const api = await apiContext(STORAGE_STATE);
	const token = uniqueToken();
	htmlSubject = `Designed mail ${token}`;
	textSubject = `Plain mail ${token}`;
	await deliverInbound(api, {
		from: `"Font Sender" <fonts@outside.test>`,
		to: SUPPORT_ADDRESS,
		subject: htmlSubject,
		text: null,
		html: '<p style="font-family:Georgia,serif">Set in the sender\'s own serif.</p>',
	});
	await deliverInbound(api, {
		from: `"Font Sender" <fonts@outside.test>`,
		to: SUPPORT_ADDRESS,
		subject: textSubject,
		text: "Plain text body.",
	});
	await api.dispose();
});

// The layout sync is off in the shared storage state, so the font choice stays in each test's own browser; the
// account's saved layout is reset all the same, in case the API round trip below stopped halfway.
test.afterAll(async () => {
	const api = await apiContext(STORAGE_STATE);
	await api.patch("/api/settings/layout", { data: { layout: { font: "auto", emailFont: "original" } } });
	await api.dispose();
});

/** Every request for a self-hosted font file or stylesheet made from now on. */
function watchFontRequests(page: Page): string[] {
	const paths: string[] = [];
	page.on("request", (request) => {
		const { pathname } = new URL(request.url());
		if (pathname.startsWith("/fonts/")) paths.push(pathname);
	});
	return paths;
}

function fontFamilyOf(page: Page, selector: string) {
	return page
		.locator(selector)
		.first()
		.evaluate((element) => getComputedStyle(element).fontFamily);
}

function readerFrame(page: Page) {
	return page.frameLocator('iframe[title="Message body"]').first();
}

test("the app, the composer and the reader switch to OpenDyslexic, which the next load has before paint", async ({
	page,
}) => {
	await page.goto("/settings/appearance");
	const font = page.getByRole("combobox", { name: "Font", exact: true });
	await expectSelectValue(font, "auto");
	await expect(page.getByRole("combobox", { name: "Font in HTML emails" })).toHaveCount(0);
	expect(await fontFamilyOf(page, "body")).not.toContain("OpenDyslexic");

	const requests = watchFontRequests(page);
	await chooseOption(font, { label: FONT });
	await expectSelectValue(font, "opendyslexic");
	await expect(page.locator("html")).toHaveAttribute("data-font", "opendyslexic");
	expect(await fontFamilyOf(page, "body")).toContain("OpenDyslexic");
	await expect
		.poll(() => requests.filter((path) => path.endsWith(".woff2")).length, { message: "the font file is fetched" })
		.toBeGreaterThan(0);
	// The faces are in the app stylesheet; no extra stylesheet is fetched for the page itself.
	expect(requests.filter((path) => path.endsWith(".css"))).toEqual([]);
	// The HTML email choice appears only for the dyslexia-friendly font and starts with the mail's own fonts.
	await expectSelectValue(page.getByRole("combobox", { name: "Font in HTML emails" }), "original");

	// The next load preloads the regular weight from <head>, before React runs.
	await page.reload();
	await expect(page.locator("html")).toHaveAttribute("data-font", "opendyslexic");
	await expect(
		page.locator(
			'head link[rel="preload"][as="font"][data-kite-font="opendyslexic"][href="/fonts/opendyslexic/opendyslexic-latin-400-normal.woff2"]',
		),
	).toHaveCount(1);
	await expectSelectValue(font, "opendyslexic");
	expect(await fontFamilyOf(page, "body")).toContain("OpenDyslexic");

	// The composer writes in it too.
	await page.goto("/inbox");
	await page.getByRole("button", { name: "Compose" }).click();
	const body = page.getByRole("textbox", { name: "Message body" });
	await expect(body).toBeVisible();
	expect(await body.evaluate((element) => getComputedStyle(element).fontFamily)).toContain("OpenDyslexic");
	await page.getByRole("button", { name: "Close composer" }).click();

	// Plain-text mail is Kite's own text; HTML mail keeps its own (sanitized) fonts until asked otherwise.
	await openMessage(page, textSubject);
	expect(await fontFamilyOf(page, "main pre")).toContain("OpenDyslexic");
	await page.goto("/inbox");
	await openMessage(page, htmlSubject);
	const frameParagraph = readerFrame(page).locator("p");
	await expect(frameParagraph).toHaveText(/own serif/);
	expect(await frameParagraph.evaluate((element) => getComputedStyle(element).fontFamily)).not.toContain(
		"OpenDyslexic",
	);

	await page.goto("/settings/appearance");
	await chooseOption(page.getByRole("combobox", { name: "Font in HTML emails" }), { label: "Dyslexia-friendly font" });
	await expect(page.locator("html")).toHaveAttribute("data-email-font", "reader");
	await page.goto("/inbox");
	await openMessage(page, htmlSubject);
	const replaced = readerFrame(page).locator("p");
	await expect(replaced).toHaveText(/own serif/);
	expect(await replaced.evaluate((element) => getComputedStyle(element).fontFamily)).toContain("OpenDyslexic");
	// The chrome keeps its normal spacing; reading text gets a little more.
	expect(await page.locator("body").evaluate((element) => getComputedStyle(element).letterSpacing)).toBe("normal");
	// The frame keeps its sandbox and loads the stylesheet from our own origin.
	await expect(page.locator('iframe[title="Message body"]').first()).toHaveAttribute("sandbox", /allow-same-origin/);
	await expect(readerFrame(page).locator('head link[href="/fonts/opendyslexic/opendyslexic.css"]')).toHaveCount(1);

	// The choice follows the account through the layout sync when a browser has it on.
	const api = await apiContext(STORAGE_STATE);
	const saved = await api.patch("/api/settings/layout", {
		data: { layout: { font: "opendyslexic", emailFont: "reader" } },
	});
	expect(saved.status(), await saved.text()).toBe(200);
	const stored = (await (await api.get("/api/settings/layout")).json()) as { layout?: Record<string, unknown> };
	expect(stored.layout).toMatchObject({ font: "opendyslexic", emailFont: "reader" });
	const refused = await api.patch("/api/settings/layout", { data: { layout: { font: "comic-sans" } } });
	expect(refused.status()).toBe(400);
	await api.patch("/api/settings/layout", { data: { layout: { font: "auto", emailFont: "original" } } });
	await api.dispose();
});

test("no font file is requested while the default font is chosen, and switching back removes it", async ({ page }) => {
	const requests = watchFontRequests(page);
	await page.goto("/inbox");
	await openMessage(page, htmlSubject);
	await expect(readerFrame(page).locator("p")).toHaveText(/own serif/);
	await page.getByRole("button", { name: "Compose" }).click();
	await expect(page.getByRole("textbox", { name: "Message body" })).toBeVisible();
	await page.getByRole("button", { name: "Close composer" }).click();
	await page.goto("/settings/appearance");
	await expect(page.locator("html")).not.toHaveAttribute("data-font", /.+/);
	await expect(page.locator("head link[data-kite-font]")).toHaveCount(0);
	expect(requests).toEqual([]);

	const font = page.getByRole("combobox", { name: "Font", exact: true });
	await chooseOption(font, { label: FONT });
	await expect(page.locator("html")).toHaveAttribute("data-font", "opendyslexic");
	await chooseOption(font, { label: DEFAULT_FONT });
	await expectSelectValue(font, "auto");
	await expect(page.locator("html")).not.toHaveAttribute("data-font", /.+/);
	await expect(page.getByRole("combobox", { name: "Font in HTML emails" })).toHaveCount(0);
	expect(await fontFamilyOf(page, "body")).not.toContain("OpenDyslexic");
	await page.reload();
	await expect(page.locator("html")).not.toHaveAttribute("data-font", /.+/);
	await expect(page.locator("head link[data-kite-font]")).toHaveCount(0);
});
