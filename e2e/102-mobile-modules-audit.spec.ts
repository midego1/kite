import { expect, test, type Page } from "@playwright/test";
import { STORAGE_STATE } from "./support/constants";
import { apiContext, uniqueToken } from "./support/helpers";
import { createFolder, uploadFile } from "./support/drive";
import { createTemplate } from "./support/module-spec";

// Mobile and foldable usability: every action available on a desktop pointer must also be visible and tappable
// (at least 44x44 CSS px, not hidden behind hover, not trapped under the tab bar or a floating pill) on a phone,
// and the layout must use the extra width an unfolded foldable gives it instead of wasting it on a static sidebar.

const PHONE = { width: 390, height: 844 };
const FOLDED_COVER = { width: 344, height: 882 };
const UNFOLDED = { width: 884, height: 1104 };
const MIN_TAP = 44;

function expectAtLeastMinTap(box: { width: number; height: number } | null) {
	expect(box, "the element has a bounding box").not.toBeNull();
	expect(box!.width, "tap target width").toBeGreaterThanOrEqual(MIN_TAP - 1);
	expect(box!.height, "tap target height").toBeGreaterThanOrEqual(MIN_TAP - 1);
}

async function scrollMainToBottom(page: Page) {
	await page.evaluate(() => document.querySelector("main")?.scrollTo(0, 1_000_000));
	await page.waitForTimeout(150);
}

test.describe("on a phone", () => {
	test.use({ viewport: PHONE, hasTouch: true });

	test("every Drive row's actions menu is at least 44px and never trapped under the section pill", async ({ page }) => {
		const api = await apiContext(STORAGE_STATE);
		const name = `Phone folder ${uniqueToken()}`;
		await createFolder(api, name);
		await api.dispose();

		await page.goto("/drive");
		const menu = page.getByRole("button", { name: `Actions for ${name}` });
		await scrollMainToBottom(page);
		await expect(menu).toBeVisible();
		expectAtLeastMinTap(await menu.boundingBox());

		const pill = page.getByRole("button", { name: "My Drive", exact: true });
		const [menuBox, pillBox] = await Promise.all([menu.boundingBox(), pill.boundingBox()]);
		// The row's own menu must clear the floating "My Drive" pill, not sit behind it.
		expect(menuBox && pillBox && menuBox.y + menuBox.height <= pillBox.y + 2).toBe(true);
		await menu.click();
		await expect(page.getByRole("menuitem", { name: /Rename/ })).toBeVisible();
	});

	test("the Money Watch row menu is at least 44px and the last row clears the Add subscription button", async ({
		page,
	}) => {
		const api = await apiContext(STORAGE_STATE);
		const vendor = `Phone Vendor ${uniqueToken()}`;
		const created = await api.post("/api/finance/subscriptions", {
			data: { vendor, amountMinor: 500, currency: "USD", cycle: "monthly" },
		});
		expect(created.ok(), await created.text()).toBe(true);
		await api.dispose();

		await page.goto("/finance");
		await scrollMainToBottom(page);
		const menu = page.getByRole("button", { name: `More actions for ${vendor}` });
		await expect(menu).toBeVisible();
		expectAtLeastMinTap(await menu.boundingBox());

		const addButton = page.getByRole("button", { name: "Add subscription" }).last();
		const [menuBox, addBox] = await Promise.all([menu.boundingBox(), addButton.boundingBox()]);
		expect(menuBox && addBox && menuBox.y + menuBox.height <= addBox.y + 2).toBe(true);
	});

	test("the Calendar new-event button is at least 44px on a phone", async ({ page }) => {
		await page.goto("/calendar");
		const button = page.getByRole("button", { name: "New event" });
		await expect(button).toBeVisible();
		expectAtLeastMinTap(await button.boundingBox());
	});

	test("a compose template can be deleted without hovering first", async ({ page }) => {
		const api = await apiContext(STORAGE_STATE);
		const title = `Phone template ${uniqueToken()}`;
		await createTemplate(api, title, "Body");
		await api.dispose();

		await page.goto("/inbox");
		await page.getByRole("button", { name: "Open menu" }).click();
		await page.getByRole("button", { name: "Compose new email" }).click();
		await page.getByRole("button", { name: "Schedule send options" }).click();
		const menu = page.getByRole("menu");
		await expect(menu.getByText("Schedule", { exact: true })).toBeVisible();
		await menu.getByRole("menuitem", { name: "Template" }).click();
		const submenu = page.getByRole("menu").last();
		const item = submenu.getByRole("menuitem", { name: title });
		await expect(item).toBeVisible();
		const deleteButton = item.getByRole("button", { name: "Delete template" });
		// On a touch screen the delete button must already be opaque: there is no hover to reveal it.
		const opacity = await deleteButton.evaluate((node) => getComputedStyle(node).opacity);
		expect(Number(opacity)).toBeGreaterThan(0.9);
		expectAtLeastMinTap(await deleteButton.boundingBox());
	});

	test("a dialog's Close button is at least 44px", async ({ page }) => {
		await page.goto("/drive");
		await page.getByRole("button", { name: "New folder" }).click();
		const close = page.getByRole("button", { name: "Close" });
		await expect(close).toBeVisible();
		// The dialog's entrance transition briefly scales the content down; wait for it to settle before measuring.
		await page.waitForTimeout(300);
		expectAtLeastMinTap(await close.boundingBox());
	});
});

test.describe("on a folded cover screen", () => {
	test.use({ viewport: FOLDED_COVER, hasTouch: true });

	test("Calendar and Drive have no horizontal overflow", async ({ page }) => {
		for (const path of ["/calendar", "/drive", "/finance"]) {
			await page.goto(path);
			const overflow = await page.evaluate(
				() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
			);
			expect(overflow, `${path} must not need horizontal scroll on a folded cover screen`).toBe(false);
		}
	});
});

test.describe("on an unfolded foldable", () => {
	test.use({ viewport: UNFOLDED, hasTouch: true });

	test("the sidebar defaults to the collapsed rail, leaving room for the page", async ({ page }) => {
		await page.goto("/calendar");
		await expect(page.getByRole("link", { name: "New email" })).toHaveCount(0);
		const width = await page.evaluate(() =>
			getComputedStyle(document.documentElement).getPropertyValue("--persisted-sidebar-width").trim(),
		);
		expect(width).toBe("72px");
	});

	test("the Drive listing never overlaps its Owner/Modified/Size columns with the Name column", async ({ page }) => {
		const api = await apiContext(STORAGE_STATE);
		const name = `Unfolded file ${uniqueToken()}.txt`;
		await uploadFile(api, name, "hello");
		await api.dispose();

		await page.goto("/drive");
		const nameCell = page.getByText(name, { exact: true });
		await expect(nameCell).toBeVisible();
		const nameBox = (await nameCell.boundingBox())!;
		const ownerHeader = page.getByText("Owner", { exact: true });
		if (await ownerHeader.isVisible().catch(() => false)) {
			const ownerBox = (await ownerHeader.boundingBox())!;
			// Either the Owner column has real room (starts to the right of the Name cell) or it is hidden;
			// it must never render on top of the file name.
			expect(ownerBox.x).toBeGreaterThanOrEqual(nameBox.x + nameBox.width - 2);
		} else {
			// The sidebar rail plus the Drive views panel leave this listing narrower than its container query
			// needs for the extra columns: they must hide gracefully (the bug) instead of overlapping the name.
			await expect(ownerHeader).toBeHidden();
		}
	});
});
