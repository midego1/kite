import { expect, test, type Page } from "@playwright/test";
import { STORAGE_STATE, SUPPORT_ADDRESS } from "./support/constants";
import { apiContext, deliverInbound, openMessage, uniqueToken } from "./support/helpers";
import { chooseOption, expectSelectValue, readOptions } from "./support/select";

// Settings → Appearance → Font → Dyslexia-friendly (OpenDyslexic): the self-hosted font takes over mail, the
// composer and the message list's text lines (HTML mail only with "Font in HTML emails") while the interface keeps
// its font ("Use it for: Text only", the default) or the whole app with "Everywhere"; it is preloaded before paint
// on the next load, and while it is not chosen no font file is requested at all.

const FONT = "Dyslexia-friendly (OpenDyslexic)";
const DEFAULT_FONT = "Match style";
let htmlSubject: string;
let textSubject: string;
let threadSubject: string;

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
	// A two-message thread: in conversation view its row carries a "[2]" count, which is interface, not text.
	threadSubject = `Thread mail ${token}`;
	const rootId = `<${token}-root@outside.test>`;
	await deliverInbound(api, {
		from: `"Font Sender" <fonts@outside.test>`,
		to: SUPPORT_ADDRESS,
		subject: threadSubject,
		text: "First message.",
		messageId: rootId,
	});
	await deliverInbound(api, {
		from: `"Font Sender" <fonts@outside.test>`,
		to: SUPPORT_ADDRESS,
		subject: `Re: ${threadSubject}`,
		text: "Second message.",
		inReplyTo: rootId,
	});
	await api.dispose();
});

// The layout sync is off in the shared storage state, so the font choice stays in each test's own browser; the
// account's saved layout is reset all the same, in case the API round trip below stopped halfway.
test.afterAll(async () => {
	const api = await apiContext(STORAGE_STATE);
	await api.patch("/api/settings/layout", {
		data: { layout: { font: "auto", emailFont: "original", fontScope: "text" } },
	});
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

test("mail, the composer and the list switch to OpenDyslexic, which the next load has before paint", async ({
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
	// Text only is the default: the interface keeps its own font and nothing is stored for the scope.
	await expectSelectValue(page.getByRole("combobox", { name: "Use it for" }), "text");
	await expect(page.locator("html")).not.toHaveAttribute("data-font-scope", /.+/);
	expect(await fontFamilyOf(page, "body")).not.toContain("OpenDyslexic");
	await page.getByRole("combobox", { name: "Font in HTML emails" }).waitFor();
	await page.goto("/inbox");
	await openMessage(page, textSubject);
	expect(await fontFamilyOf(page, "main pre")).toContain("OpenDyslexic");
	await page.goto("/settings/appearance");
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
	expect(await fontFamilyOf(page, "body")).not.toContain("OpenDyslexic");

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
		data: { layout: { font: "opendyslexic", emailFont: "reader", fontScope: "everywhere" } },
	});
	expect(saved.status(), await saved.text()).toBe(200);
	const stored = (await (await api.get("/api/settings/layout")).json()) as { layout?: Record<string, unknown> };
	expect(stored.layout).toMatchObject({ font: "opendyslexic", emailFont: "reader", fontScope: "everywhere" });
	const refused = await api.patch("/api/settings/layout", { data: { layout: { font: "comic-sans" } } });
	expect(refused.status()).toBe(400);
	const refusedScope = await api.patch("/api/settings/layout", { data: { layout: { fontScope: "nowhere" } } });
	expect(refusedScope.status()).toBe(400);
	await api.patch("/api/settings/layout", {
		data: { layout: { font: "auto", emailFont: "original", fontScope: "text" } },
	});
	await api.dispose();
});

/** The computed font of the first element: a subject line of the list, the sidebar, a button and the reader. */
async function scopeProbe(page: Page) {
	await page.goto("/inbox");
	const row = page.locator("[data-message-row]", { hasText: textSubject }).first();
	await expect(row).toBeVisible();
	const threadRow = page.locator("[data-message-row]", { hasText: threadSubject }).first();
	await expect(threadRow).toBeVisible();
	const probe = {
		listSubject: await row.getByText(textSubject).first().evaluate(computedFont),
		listSender: await row.getByText("Font Sender").first().evaluate(computedFont),
		sidebar: await page.locator("aside nav a").first().evaluate(computedFont),
		button: await page.getByRole("button", { name: "Compose" }).evaluate(computedFont),
		// The thread count in a list row sits next to the sender but is interface.
		threadCount: await threadRow
			.getByText(/\[\s*2\s*\]/)
			.first()
			.evaluate(computedFont),
		threadSender: await threadRow.getByText("Font Sender").first().evaluate(computedFont),
	};
	await page.getByRole("button", { name: "Compose" }).click();
	const body = page.getByRole("textbox", { name: "Message body" });
	await expect(body).toBeVisible();
	const composer = await body.evaluate(computedFont);
	const subjectField = await page.locator('input[placeholder="Subject"]:visible').evaluate(computedFont);
	await page.getByRole("button", { name: "Close composer" }).click();
	await openMessage(page, textSubject);
	return { ...probe, composer, subjectField, reader: await page.locator("main pre").first().evaluate(computedFont) };
}

function computedFont(element: Element) {
	return getComputedStyle(element).fontFamily;
}

test("Text only keeps the interface in its own font; Everywhere sets it in OpenDyslexic too", async ({
	page,
}, testInfo) => {
	await page.addInitScript(() => localStorage.setItem("kite-conversation-view", "on"));
	await page.goto("/settings/appearance");
	const font = page.getByRole("combobox", { name: "Font", exact: true });
	// The scope choice is only offered with the dyslexia-friendly font.
	await expect(page.getByRole("combobox", { name: "Use it for" })).toHaveCount(0);
	await chooseOption(font, { label: FONT });
	const scope = page.getByRole("combobox", { name: "Use it for" });
	await expectSelectValue(scope, "text");
	expect((await readOptions(scope)).map((option) => option.label)).toEqual(["Text only (recommended)", "Everywhere"]);

	const textOnly = await scopeProbe(page);
	for (const reading of ["listSubject", "listSender", "threadSender", "composer", "subjectField", "reader"] as const)
		expect(textOnly[reading], reading).toContain("OpenDyslexic");
	for (const chrome of ["sidebar", "button", "threadCount"] as const)
		expect(textOnly[chrome], chrome).not.toContain("OpenDyslexic");
	await page.screenshot({ path: testInfo.outputPath("text-only.png") });

	await page.goto("/settings/appearance");
	await chooseOption(scope, { label: "Everywhere" });
	await expectSelectValue(scope, "everywhere");
	await expect(page.locator("html")).toHaveAttribute("data-font-scope", "everywhere");
	expect(await fontFamilyOf(page, "body")).toContain("OpenDyslexic");
	await page.screenshot({ path: testInfo.outputPath("everywhere-settings.png") });
	await page.reload();
	await expect(page.locator("html")).toHaveAttribute("data-font-scope", "everywhere");
	await expectSelectValue(page.getByRole("combobox", { name: "Use it for" }), "everywhere");

	const everywhere = await scopeProbe(page);
	for (const [name, family] of Object.entries(everywhere)) expect(family, name).toContain("OpenDyslexic");
	await page.screenshot({ path: testInfo.outputPath("everywhere.png") });

	// Back to Text only: the attribute and the stored value go away.
	await page.goto("/settings/appearance");
	await chooseOption(page.getByRole("combobox", { name: "Use it for" }), { label: "Text only (recommended)" });
	await expect(page.locator("html")).not.toHaveAttribute("data-font-scope", /.+/);
	expect(await page.evaluate(() => localStorage.getItem("kite-font-scope"))).toBeNull();
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
