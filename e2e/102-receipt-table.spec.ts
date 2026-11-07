import { expect, test, type Page } from "@playwright/test";
import { STORAGE_STATE, SUPPORT_ADDRESS } from "./support/constants";
import { apiContext, deliverInbound, openMessage, uniqueToken } from "./support/helpers";
import { NO_WRAP_SHAPES, RECEIPT_AMOUNT, receiptTableHtml } from "../tests/fixtures/receipt-table.mjs";

// A receipt's amount sits in a cell beside a `width: 100%` description. The reader's frame wraps long words anywhere,
// which must not squeeze that cell to one character per line, while a long URL in the same mail still wraps instead of
// widening the frame (src/lib/email/word-wrap-utils.ts).

async function deliverReceipt(label: string, options?: Parameters<typeof receiptTableHtml>[0]) {
	return deliverHtml(label, receiptTableHtml(options));
}

async function deliverHtml(label: string, html: string) {
	const api = await apiContext(STORAGE_STATE);
	const subject = `${label} ${uniqueToken("receipt")}`;
	await deliverInbound(api, { from: `"Example Atlas" <receipts@outside.test>`, to: SUPPORT_ADDRESS, subject, html });
	await api.dispose();
	return subject;
}

/** How many lines each amount takes, and how far the frame's document scrolls sideways. */
async function measureReceipt(page: Page) {
	const frame = page.frameLocator('iframe[title="Message body"]');
	await expect(frame.getByText(RECEIPT_AMOUNT).first()).toBeVisible();
	return frame.locator("html").evaluate((root, amount) => {
		const cells = [...root.querySelectorAll("td")].filter((cell) => cell.textContent === amount);
		return {
			lines: cells.map((cell) => {
				const range = cell.ownerDocument.createRange();
				range.selectNodeContents(cell);
				return range.getClientRects().length;
			}),
			overflow: root.scrollWidth - root.clientWidth,
		};
	}, RECEIPT_AMOUNT);
}

test("a receipt's amounts stay on one line and its long URL wraps in the reading pane", async ({ page }) => {
	const subject = await deliverReceipt("Receipt LTR");
	await page.goto("/inbox");
	await openMessage(page, subject);
	const { lines, overflow } = await measureReceipt(page);
	expect(lines).toEqual([1, 1]);
	expect(overflow).toBe(0);
});

test.describe("on a phone", () => {
	test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

	test("a right-to-left receipt keeps its amounts whole and the reader does not scroll sideways", async ({ page }) => {
		const subject = await deliverReceipt("Receipt RTL", {
			dir: "rtl",
			description: "הקמת החברה שלך × 1",
			total: "סכום ששולם",
		});
		await page.goto("/inbox");
		await page.getByRole("list", { name: "Inbox" }).getByText(subject, { exact: true }).click();
		const { lines, overflow } = await measureReceipt(page);
		expect(lines).toEqual([1, 1]);
		expect(overflow).toBe(0);
		expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
	});
});

// Mail that says not to wrap where a phone cannot afford it: in the reader only a short table cell keeps `nowrap`.
const NO_WRAP_HTML = Object.values(NO_WRAP_SHAPES).join("");
const sidewaysScroll = (root: HTMLElement) => root.scrollWidth - root.clientWidth;

test.describe("on a narrow phone", () => {
	test.use({ viewport: { width: 360, height: 780 }, hasTouch: true });

	test("text the sender kept from wrapping still wraps, so the frame does not scroll sideways", async ({ page }) => {
		const subject = await deliverHtml("No-wrap shapes", NO_WRAP_HTML);
		await page.goto("/inbox");
		await page.getByRole("list", { name: "Inbox" }).getByText(subject, { exact: true }).click();
		const frame = page.frameLocator('iframe[title="Message body"]');
		await expect(frame.getByText("Home · Products")).toBeVisible();
		expect(await frame.locator("html").evaluate(sidewaysScroll)).toBe(0);
	});
});

test("printed, the same mail fits the page", async ({ page }) => {
	// print() is stubbed in every frame, as in 99-print-pdf.spec.ts, so no dialog opens.
	await page.addInitScript(() => {
		window.print = () => undefined;
	});
	const subject = await deliverHtml("No-wrap print", NO_WRAP_HTML);
	await page.goto("/inbox");
	await openMessage(page, subject);
	await page.getByRole("main").getByRole("button", { name: "More actions" }).first().click();
	await page.getByRole("dialog", { name: "More actions" }).getByRole("button", { name: "Print", exact: true }).click();
	const frame = page.frameLocator("#kite-print-frame");
	await expect(frame.getByText("Home · Products")).toBeAttached();
	expect(await frame.locator("html").evaluate(sidewaysScroll)).toBe(0);
});
