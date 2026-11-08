import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { STORAGE_STATE, SUPPORT_ADDRESS } from "./support/constants";
import { apiContext, openMessage, postInbound, uniqueToken, waitForMessage } from "./support/helpers";

test.use({ storageState: STORAGE_STATE });

const SHOTS = process.env.LIST_PAGER_SHOTS;

async function deliverMany(api: Awaited<ReturnType<typeof apiContext>>, label: string, count: number) {
	const mails = Array.from({ length: count }, (_, index) => ({
		from: `"Pager" <pager@outside.test>`,
		to: SUPPORT_ADDRESS,
		subject: `${label} ${index}`,
	}));
	for (const mail of mails) await postInbound(api, mail);
	return Promise.all(mails.map(async (mail) => (await waitForMessage(api, mail.subject)).id));
}

async function shot(page: Page, name: string) {
	if (!SHOTS) return;
	mkdirSync(SHOTS, { recursive: true });
	await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

const settled = (page: Page) => expect(page.getByText("STEP 5/5")).toBeHidden();
const next = (page: Page) => page.getByRole("button", { name: "Next page" });
const pagerRow = (page: Page) => next(page).locator("xpath=ancestor::div[contains(@class,'z-20')][1]");

test("the pager shares the first label's row and stays reachable and uncovered", async ({ page }) => {
	const api = await apiContext(STORAGE_STATE);
	const token = uniqueToken();
	await deliverMany(api, `Pager ${token}`, 28);
	await page.setViewportSize({ width: 1280, height: 800 });
	await page.goto("/inbox");
	const mine = page.getByRole("main").getByText(new RegExp(`^Pager ${token} \\d+$`));
	await expect(mine.first()).toBeVisible();
	await settled(page);
	await openMessage(page, new RegExp(`^Pager ${token} \\d+$`));

	const list = page.getByRole("list", { name: "Inbox" });
	const label = list.getByText("Primary", { exact: true });
	await expect(label).toBeVisible();
	await expect(next(page)).toBeVisible();
	const labelBox = (await label.boundingBox())!;
	const nextBox = (await next(page).boundingBox())!;
	// Same row: the label's vertical span contains the arrow's centre, and the arrow is right of the label.
	const centre = nextBox.y + nextBox.height / 2;
	expect(centre).toBeGreaterThan(labelBox.y);
	expect(centre).toBeLessThan(labelBox.y + labelBox.height);
	expect(nextBox.x).toBeGreaterThan(labelBox.x + labelBox.width);
	expect(nextBox.width).toBeGreaterThanOrEqual(24);
	expect(nextBox.height).toBeGreaterThanOrEqual(24);
	// The only direct children of the list are list items.
	expect(await list.evaluate((el) => [...el.children].every((child) => child.getAttribute("role") !== "button"))).toBe(
		true,
	);
	await shot(page, "inline-pager");

	// Scrolled: the pager is still on screen and is what a click at its position reaches.
	await list.evaluate((el) => {
		const scroller = el.parentElement!;
		scroller.scrollTop = scroller.scrollHeight;
	});
	await expect(next(page)).toBeInViewport();
	expect(
		await next(page).evaluate((el) => {
			const r = el.getBoundingClientRect();
			const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
			return hit === el || el.contains(hit);
		}),
	).toBe(true);

	// Keyboard focus on a row scrolled up past the top edge lands below the pager, not under it.
	const rows = list.locator("div.group");
	const bar = (await pagerRow(page).boundingBox())!;
	const target = rows.nth(4);
	await target.locator("a").first().focus();
	await expect(target.locator("a").first()).toBeFocused();
	await expect.poll(async () => (await target.boundingBox())!.y).toBeGreaterThanOrEqual(bar.y + bar.height - 1);
	await shot(page, "focus-below-pager");
});

test("a list without a section label shows the pager in a slim row", async ({ page }) => {
	const api = await apiContext(STORAGE_STATE);
	const token = uniqueToken();
	const ids = await deliverMany(api, `Slim ${token}`, 28);
	const trashed = await api.post("/api/messages/bulk", { data: { messageIds: ids, action: "trash" } });
	expect(trashed.ok(), await trashed.text()).toBe(true);
	await page.setViewportSize({ width: 1280, height: 800 });
	await page.goto("/trash");
	await expect(next(page)).toBeVisible();
	await settled(page);
	const row = (await pagerRow(page).boundingBox())!;
	expect(row.height).toBeLessThanOrEqual(33);
	await shot(page, "slim-row");

	// A selection in the full-width layout hides the pager, as the header did.
	await page.setViewportSize({ width: 390, height: 844 });
	await page.reload();
	await expect(next(page)).toBeVisible();
	await settled(page);
	// The select-all checkbox is always in the header; no "Select" mode is needed to check a row either.
	await page.getByRole("main").getByRole("checkbox").nth(1).check();
	await expect(next(page)).toBeHidden();
	await shot(page, "selection-state");
});
