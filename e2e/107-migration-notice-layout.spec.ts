import { expect, test, type Locator, type Page, type Route } from "@playwright/test";
import { STORAGE_STATE } from "./support/constants";

// The database update notice must read cleanly at every sidebar width and on a phone: no scrollbars inside it,
// no clipped words, nothing outside its box, whichever state it is in. (88-migration-progress covers what it says.)

const STATUS_API = "/api/admin/migrations";
const PENDING_API = "/api/migrations/pending";
const NAMES = [
	"0101_add_mailbox_ai_disabled_at.sql",
	"0102_add_mcp_oauth_clients_and_authorization_grants.sql",
	"0103_add_index.sql",
	"0104_add_view.sql",
];

const SIDEBAR_WIDTHS = [200, 260, 480];
const PHONE = { width: 375, height: 812 };

/** A mocked server whose POST stays open until released, with the pending list shrinking as it "applies". */
async function mockMigrations(page: Page, { fail = false } = {}) {
	let pending = [...NAMES];
	let release: (() => void) | undefined;
	const gate = new Promise<void>((resolve) => (release = resolve));
	await page.route(`**${STATUS_API}`, async (route: Route) => {
		if (route.request().method() !== "POST") {
			return route.fulfill({ json: { ready: !pending.length, pending, unknown: [] } });
		}
		await gate;
		if (fail) {
			return route.fulfill({
				status: 500,
				json: {
					error:
						"Migration 0102_add_mcp_oauth_clients_and_authorization_grants.sql failed: disk full. A backup taken just before is listed on the Backups page.",
				},
			});
		}
		pending = [];
		return route.fulfill({ json: { ready: true, pending, unknown: [], applied: NAMES, backupId: "bak_e2e" } });
	});
	await page.route(`**${PENDING_API}`, (route) =>
		route.fulfill({ json: { pending: pending.length, ...(pending.length ? { names: pending } : {}) } }),
	);
	return { landTwo: () => (pending = pending.slice(2)), finish: () => release?.() };
}

/**
 * Whatever shows a scrollbar or hides text inside the notice: an element whose content is larger than its box,
 * or a descendant sticking out of the notice. The screen-reader-only text is clipped on purpose.
 */
async function overflowing(card: Locator): Promise<string[]> {
	return card.evaluate((root) => {
		const box = root.getBoundingClientRect();
		const found: string[] = [];
		for (const element of [root, ...root.querySelectorAll<HTMLElement>("*")]) {
			if (element.closest(".sr-only") || !(element instanceof HTMLElement)) continue;
			const label = `${element.tagName.toLowerCase()}[${(element.textContent ?? "").trim().slice(0, 24)}]`;
			if (element.clientWidth > 0 && element.scrollWidth > element.clientWidth)
				found.push(`${label} scrollWidth ${element.scrollWidth} > clientWidth ${element.clientWidth}`);
			if (element.clientHeight > 0 && element.scrollHeight > element.clientHeight)
				found.push(`${label} scrollHeight ${element.scrollHeight} > clientHeight ${element.clientHeight}`);
			const rect = element.getBoundingClientRect();
			if (rect.width > 0 && (rect.left < box.left - 0.5 || rect.right > box.right + 0.5))
				found.push(`${label} sticks out horizontally`);
		}
		return found;
	});
}

async function expectClean(card: Locator) {
	expect(await overflowing(card)).toEqual([]);
	// No scrollbar anywhere on the way up to the page, either: the notice never sits in a scroller of its own.
	const scrollers = await card.evaluate((root) => {
		const found: string[] = [];
		for (let element = root.parentElement; element && element !== document.body; element = element.parentElement) {
			const style = getComputedStyle(element);
			if (/(auto|scroll)/.test(style.overflowX) && element.scrollWidth > element.clientWidth)
				found.push(`${element.tagName.toLowerCase()} scrolls horizontally`);
		}
		return found;
	});
	expect(scrollers).toEqual([]);
}

async function useSidebarWidth(page: Page, width: number) {
	await page.addInitScript((value) => localStorage.setItem("kite-column-width:sidebar", String(value)), width);
}

/** The sidebar's own notice: a list without a reading pane, so the strip above Settings shows it. */
async function openSidebarCard(page: Page, width: number) {
	await useSidebarWidth(page, width);
	// A short window is the hard case: the notice, Settings and the menu share the sidebar's height.
	await page.setViewportSize({ width: 1400, height: 640 });
	await page.goto("/drafts");
	const card = page.getByRole("navigation", { name: "Kite" }).getByTestId("migration-notice");
	await expect(card).toBeVisible();
	return card;
}

for (const width of SIDEBAR_WIDTHS) {
	test(`the sidebar notice has no overflow at a sidebar ${width}px wide, pending, applying and done`, async ({
		page,
	}) => {
		const server = await mockMigrations(page);
		const card = await openSidebarCard(page, width);
		await expect(card).toHaveAttribute("data-state", "pending");
		await expect(card).toContainText("4 updates waiting");
		await expect(card).not.toContainText(".sql");
		await expectClean(card);
		const pendingHeight = (await card.boundingBox())!.height;

		await card.getByRole("button", { name: "Update now" }).click();
		await expect(card).toHaveAttribute("data-state", "applying");
		await expect(card.getByRole("button", { name: "Updating…" })).toBeDisabled();
		await expect(card.getByRole("progressbar")).toBeVisible();
		await expect(card).toContainText("Saving a backup…");
		await expect(card).not.toContainText(".sql");
		await expectClean(card);
		// Starting the run changes nothing about the card's size, give or take a line wrapping differently.
		expect(Math.abs((await card.boundingBox())!.height - pendingHeight)).toBeLessThanOrEqual(2);

		server.landTwo();
		await expect(card).toContainText("Applying 2 of 4…");
		await expect(card.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "2");
		await expectClean(card);

		server.finish();
		const done = page.getByRole("navigation", { name: "Kite" }).getByRole("region", { name: "Database updates" });
		await expect(done).toContainText("Database updated");
		await expectClean(done);
	});
}

test("the details dialog lists the waiting updates in words, not file names", async ({ page }) => {
	await mockMigrations(page);
	const card = await openSidebarCard(page, 260);
	await card.getByRole("button", { name: "Details" }).click();
	const dialog = page.getByRole("dialog", { name: "Waiting database updates" });
	await expect(dialog).toContainText("Add mailbox AI disabled at");
	await expect(dialog).toContainText("Add MCP oauth clients and authorization grants");
	await expect(dialog).not.toContainText(".sql");
	await expect(dialog).not.toContainText("0101_");
});

test("the notice in the empty reading pane has no overflow either", async ({ page }) => {
	await mockMigrations(page);
	await page.goto("/inbox");
	const card = page.getByTestId("reading-pane-empty").getByTestId("migration-notice");
	await expect(card).toBeVisible();
	await expect(card).toContainText("new email may not appear");
	await expectClean(card);
});

test("on a 375px phone the notice has no overflow while pending, applying and done", async ({ browser }) => {
	const context = await browser.newContext({
		storageState: STORAGE_STATE,
		viewport: PHONE,
		isMobile: true,
		hasTouch: true,
	});
	const page = await context.newPage();
	const server = await mockMigrations(page);
	await page.goto("/inbox");
	const card = page.getByTestId("migration-notice");
	await expect(card).toBeVisible();
	await expect(card).toHaveAttribute("data-state", "pending");
	await expectClean(card);

	await card.getByRole("button", { name: "Update now" }).click();
	await expect(card).toHaveAttribute("data-state", "applying");
	await expectClean(card);
	server.landTwo();
	await expect(card).toContainText("Applying 2 of 4…");
	await expectClean(card);

	server.finish();
	const done = page.getByRole("region", { name: "Database updates" });
	await expect(done).toContainText("Database updated");
	await expectClean(done);
	await context.close();
});

test("a failed update shows a clear error with Retry and a link to Admin, without overflow", async ({ page }) => {
	const server = await mockMigrations(page, { fail: true });
	const card = await openSidebarCard(page, 200);
	await card.getByRole("button", { name: "Update now" }).click();
	server.finish();

	await expect(card).toHaveAttribute("data-state", "failed");
	await expect(card).toContainText("Update failed");
	await expect(card.getByRole("alert")).toContainText("The database update failed.");
	await expect(card.getByRole("alert")).toContainText("disk full");
	await expect(card.getByRole("link", { name: "Admin overview" })).toHaveAttribute("href", "/admin");
	await expect(card.getByRole("button", { name: "Retry" })).toBeEnabled();
	await expectClean(card);
});

for (const variant of [
	{ style: "kite", theme: "light" },
	{ style: "kite", theme: "dark" },
	{ style: "classic", theme: "light" },
	{ style: "classic", theme: "dark" },
]) {
	test(`the notice has no overflow in ${variant.style}, ${variant.theme}`, async ({ page }) => {
		await page.addInitScript(({ style, theme }) => {
			localStorage.setItem("kite-style", style);
			localStorage.setItem("kite-theme", theme);
		}, variant);
		await mockMigrations(page);
		const card = await openSidebarCard(page, 220);
		await expectClean(card);
	});
}

for (const variant of [
	{ language: "nl", dir: "ltr", pending: "4 updates wachten", applying: "Back-up opslaan…", button: "Nu bijwerken" },
	{
		language: "ar",
		dir: "rtl",
		pending: "4 تحديثات بانتظار التطبيق",
		applying: "جارٍ حفظ نسخة احتياطية…",
		button: "حدّث الآن",
	},
]) {
	test(`the notice is translated to ${variant.language} and keeps its layout (${variant.dir})`, async ({ page }) => {
		await page.addInitScript((language) => {
			localStorage.setItem("kite-layout-sync", "off");
			localStorage.setItem("kite-interface-language", language);
		}, variant.language);
		const server = await mockMigrations(page);
		const card = await openSidebarCard(page, 200);
		await expect(page.locator("html")).toHaveAttribute("dir", variant.dir);
		await expect(card).toContainText(variant.pending);
		await expectClean(card);

		await card.getByRole("button", { name: variant.button }).click();
		await expect(card).toHaveAttribute("data-state", "applying");
		await expect(card).toContainText(variant.applying);
		await expectClean(card);
		server.finish();
	});
}
