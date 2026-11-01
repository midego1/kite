import { expect, test, type Page } from "@playwright/test";
import { createSignedInAccount } from "./support/auto-read";
import { BASE_URL, DOMAIN, STORAGE_STATE } from "./support/constants";
import { apiContext, deliverInbound, postInbound, uniqueToken } from "./support/helpers";

// The message list scrolls inside its own panel (src/components/messages/message-split-layout.tsx): a folder with
// more mail than fits never grows the page, whatever the window's height, so the list's and the reader's rounded
// panels end at the bottom of the window and the rows past it are reached by scrolling the list.

const HEIGHTS = [900, 1650];

/** The page's and the panels' bottoms against the window, and whether the list scrolls on its own. */
async function measure(page: Page) {
	return page.evaluate(() => {
		const bottom = (element: Element | null) => (element ? Math.round(element.getBoundingClientRect().bottom) : null);
		const list = document.getElementById("kite-message-list-panel");
		const scroller = list?.querySelector("[data-density]") ?? null;
		return {
			viewport: window.innerHeight,
			documentScroll: document.documentElement.scrollHeight,
			pageScroll: document.querySelector("main")!.scrollHeight,
			pageClient: document.querySelector("main")!.clientHeight,
			listPanel: bottom(list?.querySelector("aside") ?? null),
			reader: bottom(document.querySelector('[data-testid="reading-pane-empty"]')),
			listScrolls: !!scroller && scroller.scrollHeight > scroller.clientHeight,
			rowsBottom: bottom(list?.querySelector('[role="list"]') ?? null),
		};
	});
}

test("a long inbox scrolls inside the list panel instead of growing the page", async ({ browser }) => {
	const owner = await apiContext(STORAGE_STATE);
	const username = `tall${uniqueToken("")}`;
	const member = await createSignedInAccount(owner, username);
	const context = await browser.newContext({ baseURL: BASE_URL, storageState: await member.api.storageState() });
	try {
		// More than one page of the list (25 rows) at the tallest window below.
		for (let index = 1; index <= 30; index++) {
			const mail = {
				from: `"Tall Sender ${index}" <${uniqueToken("tall")}@outside.test>`,
				to: `${username}@${DOMAIN}`,
				subject: `Tall list ${index} ${uniqueToken("")}`,
				text: "Fills the list.",
			};
			if (index < 30) await postInbound(member.api, mail);
			else await deliverInbound(member.api, mail);
		}
		const page = await context.newPage();
		for (const height of HEIGHTS) {
			await page.setViewportSize({ width: 1710, height });
			await page.goto("/inbox");
			await expect(page.getByTestId("reading-pane-empty")).toBeVisible();
			await expect(page.getByRole("main").locator("div.group").first()).toBeVisible();
			const before = await measure(page);
			expect(before.documentScroll, `window ${height}: the document does not scroll`).toBe(before.viewport);
			expect(before.pageScroll, `window ${height}: the page panel does not scroll`).toBe(before.pageClient);
			expect(before.listPanel, `window ${height}: the list panel ends in the window`).toBeLessThanOrEqual(height);
			expect(before.reader, `window ${height}: the reader ends in the window`).toBeLessThanOrEqual(height);
			expect(before.listScrolls, `window ${height}: the list scrolls on its own`).toBe(true);
			expect(before.rowsBottom!, `window ${height}: rows wait below the fold`).toBeGreaterThan(height);
			// Scrolling the list brings the last row up without moving anything else.
			await page.getByRole("main").locator("div.group").last().scrollIntoViewIfNeeded();
			const after = await measure(page);
			expect(after.rowsBottom!).toBeLessThanOrEqual(after.listPanel!);
			expect(after.documentScroll).toBe(after.viewport);
			expect(after.listPanel).toBe(before.listPanel);
		}
	} finally {
		await context.close();
		await member.api.dispose();
		await owner.dispose();
	}
});
