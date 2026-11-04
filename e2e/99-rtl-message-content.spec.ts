import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { STORAGE_STATE, SUPPORT_ADDRESS } from "./support/constants";
import { apiContext, deliverInbound, openMessage, uniqueToken } from "./support/helpers";

// Mail in Arabic, Hebrew, Persian or Urdu reads right to left inside the English interface (ROADMAP milestone 1):
// subjects, sender names, HTML and plain-text bodies follow their own text, and Latin mail is unchanged.

let api: APIRequestContext;

test.beforeAll(async () => {
	api = await apiContext(STORAGE_STATE);
});

test.afterAll(async () => {
	await api.dispose();
});

const direction = (locator: Locator) => locator.evaluate((element) => getComputedStyle(element).direction);

function listRow(page: Page, token: string) {
	return page.locator("[data-message-row]").filter({ hasText: token }).first();
}

/**
 * Where the first and the last line of text in `locator` sit in their block: against its right edge or its left one.
 * Each line of a plain-text message takes the direction of its own first letter.
 */
async function lineEdges(locator: Locator): Promise<{ first: "left" | "right"; last: "left" | "right" }> {
	return locator.evaluate((element) => {
		const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
		const rects: DOMRect[] = [];
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			const range = document.createRange();
			range.selectNodeContents(node);
			rects.push(...Array.from(range.getClientRects()).filter((rect) => rect.width > 0));
		}
		const box = element.getBoundingClientRect();
		const top = Math.min(...rects.map((rect) => rect.top));
		const bottom = Math.max(...rects.map((rect) => rect.top));
		const side = (line: DOMRect[]) =>
			box.right - Math.max(...line.map((rect) => rect.right)) < Math.min(...line.map((rect) => rect.left)) - box.left
				? "right"
				: "left";
		return {
			first: side(rects.filter((rect) => Math.abs(rect.top - top) < 4)),
			last: side(rects.filter((rect) => Math.abs(rect.top - bottom) < 4)),
		};
	});
}

test("an Arabic HTML message reads right to left in the list, the reader and the frame", async ({ page }) => {
	const token = uniqueToken("rtl-ar");
	const subject = `مرحبا بكم في كايت ${token}`;
	await deliverInbound(api, {
		from: `"محمد علي" <mohamed-${token}@outside.test>`,
		to: SUPPORT_ADDRESS,
		subject,
		text: "مرحبا بكم. هذه رسالة تجريبية.",
		html: `<p>مرحبا بكم. هذه رسالة تجريبية.</p><ul><li>أول</li></ul><div dir="ltr">Order 42 stays left to right</div><blockquote>اقتباس</blockquote>`,
	});

	await page.goto("/inbox");
	const row = listRow(page, token);
	await expect(row).toBeVisible();
	await expect(row.locator('[dir="auto"]', { hasText: "محمد علي" }).first()).toBeVisible();
	expect(await direction(row.locator('[dir="auto"]', { hasText: "محمد علي" }).first())).toBe("rtl");
	expect(await direction(row.locator('[dir="auto"]', { hasText: subject }).first())).toBe("rtl");

	await openMessage(page, subject);
	const heading = page.getByRole("heading", { level: 1, name: subject });
	await expect(heading).toBeVisible();
	expect(await direction(heading)).toBe("rtl");

	const frame = page.frameLocator('iframe[title="Message body"]');
	const body = frame.locator("body");
	await expect(frame.getByText("مرحبا بكم. هذه رسالة تجريبية.")).toBeVisible();
	await expect(body).toHaveAttribute("dir", "auto");
	expect(await direction(body)).toBe("rtl");
	expect(await direction(frame.locator("li"))).toBe("rtl");
	// The sender's own dir attribute wins for that element, and the quote bar moves to the reading start.
	expect(await direction(frame.getByText("Order 42 stays left to right"))).toBe("ltr");
	expect(await frame.locator("blockquote").evaluate((element) => getComputedStyle(element).borderRightWidth)).toBe(
		"2px",
	);
	expect(await frame.locator("blockquote").evaluate((element) => getComputedStyle(element).borderLeftWidth)).toBe(
		"0px",
	);
});

test("a Hebrew plain-text message reads right to left and aligns right", async ({ page }) => {
	const token = uniqueToken("rtl-he");
	const subject = `שלום וברוכים הבאים ${token}`;
	await deliverInbound(api, {
		from: `"דנה כהן" <dana-${token}@outside.test>`,
		to: SUPPORT_ADDRESS,
		subject,
		text: "שלום, זו הודעת בדיקה בעברית.\n\nLine two is Latin, mixed with עברית inside it.",
	});

	await page.goto("/inbox");
	const row = listRow(page, token);
	await expect(row).toBeVisible();
	expect(await direction(row.locator('[dir="auto"]', { hasText: "דנה כהן" }).first())).toBe("rtl");
	expect(await direction(row.locator('[dir="auto"]', { hasText: subject }).first())).toBe("rtl");

	await openMessage(page, subject);
	expect(await direction(page.getByRole("heading", { level: 1, name: subject }))).toBe("rtl");
	const text = page.locator("pre").filter({ hasText: "שלום, זו הודעת בדיקה בעברית." }).first();
	await expect(text).toBeVisible();
	await expect(text).toHaveAttribute("dir", "auto");
	expect(await direction(text)).toBe("rtl");
	// The Hebrew line sits against the right edge; the Latin line below it, with Hebrew inside, against the left.
	expect(await lineEdges(text)).toEqual({ first: "right", last: "left" });
	await expect(text).toContainText("Line two is Latin, mixed with עברית inside it.");
});

test("a Latin message keeps its left to right layout, even with a stretch of Arabic in it", async ({ page }) => {
	const token = uniqueToken("rtl-en");
	const subject = `Quarterly report ${token}`;
	await deliverInbound(api, {
		from: `"Ann Lee" <ann-${token}@outside.test>`,
		to: SUPPORT_ADDRESS,
		subject,
		text: "Hello there.",
		html: `<p>Hello there, the Arabic word مرحبا sits inside this line.</p><p dir="rtl">Sender asked for this paragraph to be right to left</p><ul><li>one</li></ul><blockquote>quoted</blockquote>`,
	});

	await page.goto("/inbox");
	const row = listRow(page, token);
	await expect(row).toBeVisible();
	expect(await direction(row.locator('[dir="auto"]', { hasText: "Ann Lee" }).first())).toBe("ltr");
	expect(await direction(row.locator('[dir="auto"]', { hasText: subject }).first())).toBe("ltr");

	await openMessage(page, subject);
	expect(await direction(page.getByRole("heading", { level: 1, name: subject }))).toBe("ltr");
	const frame = page.frameLocator('iframe[title="Message body"]');
	await expect(frame.getByText("Hello there, the Arabic word")).toBeVisible();
	expect(await direction(frame.locator("body"))).toBe("ltr");
	expect(await direction(frame.getByText("Sender asked for this paragraph"))).toBe("rtl");
	expect(await frame.locator("ul").evaluate((element) => getComputedStyle(element).paddingLeft)).toBe("24px");
	expect(await frame.locator("blockquote").evaluate((element) => getComputedStyle(element).borderLeftWidth)).toBe(
		"2px",
	);
});
