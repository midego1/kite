import { expect, test, type Browser, type Page } from "@playwright/test";
import { STORAGE_STATE } from "./support/constants";

// The Language setting (ROADMAP milestone 1): Automatic takes Dutch from the browser, Arabic needs a choice while it is an
// unreviewed draft, a choice is stored like the reading layout and a language's catalog is fetched only by someone reading
// it. Automatic direction follows the language, and public pages stay English and left to right.

const LANGUAGE_KEY = "kite-interface-language";
const SIDEBAR = "#kite-sidebar-panel";

/** A browser of its own, with the shared admin's account layout kept out of it (see e2e/74-layout-preferences). */
async function openBrowser(browser: Browser, locale: string, chosen?: string): Promise<Page> {
	const context = await browser.newContext({ locale, storageState: STORAGE_STATE });
	const page = await context.newPage();
	await page.addInitScript(
		([key, value]) => {
			localStorage.setItem("kite-layout-sync", "off");
			if (value && !localStorage.getItem(key!)) localStorage.setItem(key!, value);
		},
		[LANGUAGE_KEY, chosen ?? ""],
	);
	return page;
}

async function openInbox(page: Page) {
	await page.goto("/inbox");
	await expect(page.locator(SIDEBAR)).toBeVisible();
}

const nav = (page: Page, name: string) => page.locator(SIDEBAR).getByRole("link", { name, exact: true });

async function chooseLanguage(page: Page, menu: string, language: string) {
	const account = page.getByRole("button", { name: menu });
	await expect(account).toBeVisible({ timeout: 45_000 });
	await account.click();
	await page.getByRole("radio", { name: language, exact: true }).click();
	await page.keyboard.press("Escape");
}

const expectHtml = async (page: Page, lang: string, dir: string) => {
	await expect(page.locator("html")).toHaveAttribute("lang", lang);
	await expect(page.locator("html")).toHaveAttribute("dir", dir);
};

test.describe("interface language", () => {
	test("switching to Dutch changes the shell at once and a reload keeps it", async ({ browser }) => {
		const page = await openBrowser(browser, "en-US");
		await openInbox(page);
		await expect(nav(page, "Sent")).toBeVisible();

		await chooseLanguage(page, "Open account menu", "Nederlands");
		await expect(nav(page, "Verzonden")).toBeVisible();
		await expect(nav(page, "Concepten")).toBeVisible();
		await expectHtml(page, "nl", "ltr");
		await expect(page.getByRole("textbox", { name: "Mail doorzoeken" })).toBeVisible();

		await page.reload();
		await expect(nav(page, "Verzonden")).toBeVisible();
		await expectHtml(page, "nl", "ltr");

		await chooseLanguage(page, "Accountmenu openen", "English");
		await expect(nav(page, "Sent")).toBeVisible();
		await expectHtml(page, "en", "ltr");
		await page.context().close();
	});

	test("Arabic translates and mirrors from the first frame, and an explicit direction wins", async ({ browser }) => {
		const page = await openBrowser(browser, "en-US");
		await openInbox(page);
		await chooseLanguage(page, "Open account menu", "العربية");
		await expect(nav(page, "المُرسَلة")).toBeVisible();
		await expectHtml(page, "ar", "rtl");
		const sidebar = await page.locator(SIDEBAR).boundingBox();
		expect(sidebar!.x).toBeGreaterThan(page.viewportSize()!.width / 2);

		await page.addInitScript(() => {
			const record = { atBody: null as string | null };
			(window as unknown as { __html: typeof record }).__html = record;
			const watch = new MutationObserver(() => {
				if (!document.body) return;
				record.atBody = `${document.documentElement.lang} ${document.documentElement.dir}`;
				watch.disconnect();
			});
			watch.observe(document, { childList: true, subtree: true });
		});
		await page.reload();
		await expect(nav(page, "المُرسَلة")).toBeVisible();
		await expectHtml(page, "ar", "rtl");
		const first = await page.evaluate(() => (window as unknown as { __html: { atBody: string } }).__html.atBody);
		expect(first).toBe("ar rtl");

		await chooseLanguage(page, "فتح قائمة الحساب", "من اليسار");
		await expectHtml(page, "ar", "ltr");
		await page.context().close();
	});

	test("dates follow the language, and English keeps the browser's", async ({ browser }) => {
		const longDate = (locale: string) => new Intl.DateTimeFormat(locale, { month: "long" }).format(new Date());
		for (const [locale, chosen, expected] of [
			["en-US", "nl", longDate("nl")],
			["en-US", "ar", longDate("ar")],
			["de-DE", "en", longDate("de-DE")],
		] as const) {
			const page = await openBrowser(browser, locale, chosen);
			await openInbox(page);
			await expect(page.getByText(expected, { exact: false }).first()).toBeVisible();
			await page.context().close();
		}
	});

	test("Automatic takes Dutch from the browser; Arabic and languages Kite lacks stay English", async ({ browser }) => {
		for (const [locale, sent, lang, dir] of [
			["nl-BE", "Verzonden", "nl", "ltr"],
			["ar-EG", "Sent", "en", "ltr"],
			["he-IL", "Sent", "en", "ltr"],
			["fr-FR", "Sent", "en", "ltr"],
		] as const) {
			const page = await openBrowser(browser, locale);
			await openInbox(page);
			await expect(nav(page, sent)).toBeVisible();
			await expectHtml(page, lang, dir);
			await page.context().close();
		}
	});

	test("public pages stay English and left to right for someone who chose Arabic", async ({ browser }) => {
		const page = await openBrowser(browser, "ar-EG", "ar");
		for (const path of ["/d/no-such-link", "/book/no-such-user", "/"]) {
			await page.goto(path);
			await expectHtml(page, "en", "ltr");
		}
		await page.goto("/inbox");
		await expect(nav(page, "المُرسَلة")).toBeVisible();
		await expectHtml(page, "ar", "rtl");
		await page.context().close();

		const signedOut = await browser.newContext({ locale: "ar-EG", storageState: { cookies: [], origins: [] } });
		const login = await signedOut.newPage();
		await login.addInitScript((key) => localStorage.setItem(key, "ar"), LANGUAGE_KEY);
		await login.goto("/login");
		await expect(login.getByRole("button", { name: /sign in/i }).first()).toBeVisible();
		await expectHtml(login, "en", "ltr");
		await signedOut.close();
	});

	test("English downloads no catalog, and an Arabic reader fetches only theirs", async ({ browser }) => {
		const catalogs = (urls: string[]) => urls.filter((url) => /locales[/_-]|\/(nl|ar)[-.][\w-]*\.js/.test(url));
		const english = await openBrowser(browser, "en-US");
		const englishUrls: string[] = [];
		english.on("request", (request) => englishUrls.push(request.url()));
		await openInbox(english);
		await expect(nav(english, "Sent")).toBeVisible();
		expect(catalogs(englishUrls)).toEqual([]);
		await english.context().close();

		const arabic = await openBrowser(browser, "en-US", "ar");
		const arabicUrls: string[] = [];
		arabic.on("request", (request) => arabicUrls.push(request.url()));
		await openInbox(arabic);
		await expect(nav(arabic, "المُرسَلة")).toBeVisible();
		expect(catalogs(arabicUrls).length).toBeGreaterThan(0);
		expect(catalogs(arabicUrls).filter((url) => url.includes("nl."))).toEqual([]);
		await arabic.context().close();
	});
});
