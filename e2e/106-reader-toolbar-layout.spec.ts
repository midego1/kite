import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { BASE_URL, DOMAIN, STORAGE_STATE, SUPPORT_ADDRESS } from "./support/constants";
import { apiContext, deliverInbound, openMessage, uniqueToken } from "./support/helpers";
import { createSharedMailbox, createSignedInAccount, selectMailbox, shareMailbox } from "./support/auto-read";

// The reader toolbar is one row at every width (what does not fit moves into More actions), and every control of
// the message list lies inside the list panel, whatever width the list was dragged to.

/** Set to a directory to save the screenshots there (the PR's before and after). */
const SHOT_DIR = process.env.TOOLBAR_SHOT_DIR;

let subject: string;

test.beforeAll(async () => {
	const api = await apiContext(STORAGE_STATE);
	subject = `Toolbar layout ${uniqueToken()}`;
	for (const title of [`Filler A ${subject}`, `Filler B ${subject}`, subject]) {
		await deliverInbound(api, {
			from: `"Layout Sender" <layout@outside.test>`,
			to: SUPPORT_ADDRESS,
			subject: title,
			text: "Reader toolbar layout body.",
		});
	}
	await api.dispose();
});

test.beforeEach(async ({ page }) => {
	await page.addInitScript(() => localStorage.setItem("kite-theme", "light"));
});

/** Saves a list width and reloads to apply it (the account's own copy wins over the device's, so both change). */
async function applyListWidth(page: Page, width: number) {
	await page.evaluate((value) => {
		for (const key of Object.keys(localStorage)) {
			if (key.startsWith("kite-column-width:message-list:")) localStorage.setItem(key, String(value));
		}
		localStorage.setItem("kite-column-width:message-list", String(value));
	}, width);
	await page.reload();
}

function header(page: Page) {
	return page.locator("div.sticky").filter({ has: page.getByRole("button", { name: "Newer email" }) });
}

type ToolbarReport = {
	outside: string[];
	tops: number[];
	labels: string[];
	smallest: number;
	headerBox: { x: number; y: number; width: number; height: number };
	rowHeight: number;
};

/** Every button the toolbar shows (not the overflowed ones, which are `invisible`): its box, read in one go. */
async function readToolbar(page: Page): Promise<ToolbarReport> {
	const bar = header(page).locator(".reader-toolbar");
	await expect(bar).toBeVisible();
	await expect(bar.getByRole("button", { name: "More actions" })).toBeVisible();
	return header(page).evaluate((head) => {
		const root = head.querySelector(".reader-toolbar") as HTMLElement;
		const box = head.getBoundingClientRect();
		const buttons = [...root.querySelectorAll("button")].filter((button) => {
			const style = getComputedStyle(button);
			return style.visibility !== "hidden" && style.display !== "none";
		});
		const rects = buttons.map((button) => button.getBoundingClientRect());
		return {
			outside: buttons
				.filter((_, index) => {
					const r = rects[index];
					return (
						r.left < box.left - 0.5 || r.right > box.right + 0.5 || r.top < box.top - 0.5 || r.bottom > box.bottom + 0.5
					);
				})
				.map((button) => button.getAttribute("aria-label") ?? button.textContent ?? "?"),
			tops: rects.map((r) => Math.round(r.top)),
			labels: buttons.map((button) => button.getAttribute("aria-label") ?? button.textContent ?? "?"),
			smallest: Math.min(...rects.map((r) => Math.min(r.width, r.height))),
			headerBox: box.toJSON(),
			rowHeight: root.getBoundingClientRect().height,
		};
	});
}

/** One row: every shown button shares a top, none leaves the header, and the header kept its one-row height. */
async function expectSingleRow(page: Page, context: string, minTarget = 0) {
	let report: ToolbarReport | undefined;
	await expect(async () => {
		report = await readToolbar(page);
		expect(report.outside, `${context}: buttons outside the header`).toEqual([]);
		expect(new Set(report.tops).size, `${context}: tops ${report.tops.join(",")} (${report.labels.join(", ")})`).toBe(
			1,
		);
	}).toPass({ timeout: 10_000 });
	expect(report!.headerBox.height, `${context}: header grew to ${report!.headerBox.height}`).toBeLessThanOrEqual(57);
	expect(report!.smallest, `${context}: smallest button`).toBeGreaterThanOrEqual(minTarget);
	return report!;
}

/** Whatever is not inline is in More actions: nothing disappears. */
async function expectReachable(page: Page, report: ToolbarReport, names: { inline: string; menu: string }[]) {
	const missing = names.filter(({ inline }) => !report.labels.some((label) => label.startsWith(inline)));
	if (missing.length === 0) return;
	await header(page).getByRole("button", { name: "More actions" }).click();
	const menu = page.getByRole("dialog", { name: "More actions" });
	for (const { menu: text } of missing) {
		await expect(
			menu.getByRole("button", { name: text, exact: true }),
			`${text} reachable in More actions`,
		).toBeVisible();
	}
	await page.keyboard.press("Escape");
}

const DESKTOP_CASES: [number, number, number][] = [
	[1280, 800, 300],
	[1280, 800, 360],
	[1280, 800, 450],
	[1280, 800, 700],
	[1440, 900, 300],
	[1440, 900, 360],
	[1440, 900, 450],
];

test.describe("desktop", () => {
	for (const [width, height, listWidth] of DESKTOP_CASES) {
		test(`${width}x${height}, list ${listWidth}px: one toolbar row, every list control inside the list`, async ({
			page,
		}) => {
			await page.setViewportSize({ width, height });
			await page.goto("/inbox");
			await applyListWidth(page, listWidth);
			await openMessage(page, subject);
			await expect(page.getByRole("heading", { level: 1, name: subject })).toBeVisible();

			const context = `${width}x${height} list ${listWidth}`;
			const report = await expectSingleRow(page, context);
			// Delete and More actions never move into the menu.
			expect(report.labels.some((label) => label.startsWith("Move to trash"))).toBe(true);
			expect(report.labels).toContain("More actions");
			await expectReachable(page, report, [
				{ inline: "Archive", menu: "Archive" },
				{ inline: "Report spam", menu: "Report spam" },
				{ inline: "Mark as", menu: "Mark as unread" },
			]);

			await expectListFits(page, context);
			if (SHOT_DIR) {
				mkdirSync(SHOT_DIR, { recursive: true });
				await page.screenshot({ path: `${SHOT_DIR}/${width}x${height}-list${listWidth}.png` });
			}
		});
	}

	test("1440x900, list 700px: a wide Reply all does not leave the icon actions unused", async ({ page }) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		await page.goto("/inbox");
		await applyListWidth(page, 700);
		await openMessage(page, subject);
		await expect(page.getByRole("heading", { level: 1, name: subject })).toBeVisible();
		const report = await expectSingleRow(page, "1440x900 list 700");
		// More and Delete are always there; room for at least one icon action beyond them is used.
		expect(report.labels.length, report.labels.join(", ")).toBeGreaterThan(2);
		await expectReachable(page, report, [
			{ inline: "Archive", menu: "Archive" },
			{ inline: "Report spam", menu: "Report spam" },
			{ inline: "Mark as", menu: "Mark as unread" },
		]);
	});

	test("a narrow reader keeps one row and More actions holds what moved", async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 800 });
		await page.goto("/inbox");
		await applyListWidth(page, 900);
		await openMessage(page, subject);
		const report = await expectSingleRow(page, "narrow reader");
		// The list is dragged near its widest, so the reader cannot hold every action.
		expect(report.labels.length).toBeLessThan(8);
		expect(report.labels).toContain("More actions");
		await header(page).getByRole("button", { name: "More actions" }).click();
		const menu = page.getByRole("dialog", { name: "More actions" });
		await expect(menu.getByRole("button", { name: "Archive", exact: true })).toBeVisible();
		await page.keyboard.press("Escape");
	});
});

/** Right to left: the same one row, nothing outside the header and every list control inside the list. */
test.describe("right to left", () => {
	for (const [width, height, listWidth] of [
		[1280, 800, 360],
		[1440, 900, 700],
	] as const) {
		test(`${width}x${height}, list ${listWidth}px in Arabic layout`, async ({ page }) => {
			await page.addInitScript(() => {
				localStorage.setItem("kite-layout-sync", "off");
				localStorage.setItem("kite-interface-direction", "rtl");
			});
			await page.setViewportSize({ width, height });
			await page.goto("/inbox");
			await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
			await applyListWidth(page, listWidth);
			await openMessage(page, subject);
			await expect(page.getByRole("heading", { level: 1, name: subject })).toBeVisible();
			const context = `rtl ${width}x${height} list ${listWidth}`;
			const report = await expectSingleRow(page, context);
			expect(report.labels.some((label) => label.startsWith("Move to trash"))).toBe(true);
			expect(report.labels).toContain("More actions");
			await expectReachable(page, report, [
				{ inline: "Archive", menu: "Archive" },
				{ inline: "Report spam", menu: "Report spam" },
			]);
			await expectListFits(page, context);
		});
	}
});

/** Shared mail the user can only read: the toolbar's Move controls are disabled, inline and inside More actions. */
test.describe("read-only shared mail", () => {
	test("the Move to items in More actions are disabled like the inline Move button", async ({ browser }) => {
		const admin = await apiContext(STORAGE_STATE);
		const token = uniqueToken("ro");
		const sharedId = await createSharedMailbox(admin, `shared${token}`);
		const viewer = await createSignedInAccount(admin, `viewer${token}`);
		await shareMailbox(admin, sharedId, viewer.id, "read_only");
		const readOnlySubject = `Read only ${token}`;
		const message = await deliverInbound(admin, {
			from: `"Layout Sender" <layout@outside.test>`,
			to: `shared${token}@${DOMAIN}`,
			subject: readOnlySubject,
			text: "Read only body.",
		});

		const context = await browser.newContext({ baseURL: BASE_URL, storageState: await viewer.api.storageState() });
		const readerPage = await context.newPage();
		await readerPage.addInitScript(() => localStorage.setItem("kite-theme", "light"));
		await selectMailbox(readerPage, sharedId);
		await readerPage.setViewportSize({ width: 1280, height: 800 });
		await readerPage.goto(`/inbox/${message.id}`);
		await expect(readerPage.getByRole("heading", { level: 1, name: readOnlySubject })).toBeVisible();

		await expect(header(readerPage).getByRole("button", { name: "More actions" })).toBeVisible();
		await header(readerPage).getByRole("button", { name: "More actions" }).click();
		const menu = readerPage.getByRole("dialog", { name: "More actions" });
		for (const name of ["Archived", "Spam", "Trash"]) {
			await expect(menu.getByRole("button", { name, exact: true }), `${name} in Move to`).toBeDisabled();
		}
		await context.close();
		await admin.dispose();
	});
});

/**
 * Every control and row of the list lies inside the list panel (or the main pane when there is no split): the
 * clipping box that cut the Select button, search field, chips, pager and each row's sender and subject off.
 */
async function expectListFits(page: Page, context: string) {
	const panel = page.locator("#kite-message-list-panel");
	const container = (await panel.count()) > 0 ? panel : page.getByRole("main");
	await expect(container.getByRole("checkbox", { name: "Select all visible messages" })).toBeVisible();
	await expect(container.getByRole("link", { name: "List settings" })).toBeVisible();
	await expect(container.locator('input[placeholder*="Search"]').first()).toBeVisible();
	const report = await container.evaluate((el) => {
		const box = el.getBoundingClientRect();
		const candidates = [
			...el.querySelectorAll<HTMLElement>(
				"button, a[href], input, [data-message-row], [data-message-row] [data-sender], [data-message-row] h3",
			),
		];
		const outside: string[] = [];
		for (const node of candidates) {
			const style = getComputedStyle(node);
			if (style.visibility === "hidden" || style.display === "none") continue;
			// Hover-only actions are invisible until a row is hovered; they have no business being measured.
			let hiddenByOpacity = false;
			for (let parent: HTMLElement | null = node; parent && parent !== el; parent = parent.parentElement) {
				if (getComputedStyle(parent).opacity === "0") hiddenByOpacity = true;
			}
			if (hiddenByOpacity) continue;
			const r = node.getBoundingClientRect();
			if (r.width === 0 || r.height === 0) continue;
			// The list scrolls vertically: only horizontal containment matters for rows below the fold.
			const inside = r.left >= box.left - 0.5 && r.right <= box.right + 0.5;
			if (!inside)
				outside.push(
					`${node.tagName.toLowerCase()}[${node.getAttribute("aria-label") ?? node.textContent?.trim().slice(0, 24) ?? ""}] ${Math.round(r.left - box.left)}..${Math.round(r.right - box.left)} of ${Math.round(box.width)}`,
				);
		}
		const scrollers = [el, ...el.querySelectorAll<HTMLElement>("*")]
			.filter((node) => node.scrollLeft !== 0)
			.map((node) => node.tagName);
		return { outside, scrollers, overflowX: el.scrollWidth - el.clientWidth };
	});
	expect(report.outside, `${context}: list controls outside the list`).toEqual([]);
	expect(report.scrollers, `${context}: a list ancestor is scrolled sideways`).toEqual([]);
	expect(report.overflowX, `${context}: the list is wider than its column`).toBeLessThanOrEqual(1);
}

test.describe("phone", () => {
	test.use({ viewport: { width: 375, height: 812 }, hasTouch: true });

	test("375px: one row of 44px targets with Reply, Delete and More actions", async ({ page }) => {
		await page.goto("/inbox");
		await openMessage(page, subject);
		await expect(page.getByRole("heading", { level: 1, name: subject })).toBeVisible();
		const report = await expectSingleRow(page, "375px phone", 44);
		expect(report.labels).toContain("Move to trash");
		expect(report.labels).toContain("More actions");
		await expectReachable(page, report, [
			{ inline: "Reply", menu: "Reply" },
			{ inline: "Report spam", menu: "Report spam" },
		]);
		if (SHOT_DIR) {
			mkdirSync(SHOT_DIR, { recursive: true });
			await page.screenshot({ path: `${SHOT_DIR}/375x812.png` });
		}
	});

	test("a small phone keeps Delete and More actions in one row", async ({ page }) => {
		await page.setViewportSize({ width: 320, height: 640 });
		await page.goto("/inbox");
		await openMessage(page, subject);
		await expect(page.getByRole("heading", { level: 1, name: subject })).toBeVisible();
		const report = await expectSingleRow(page, "320px phone", 44);
		expect(report.labels).toContain("Move to trash");
		expect(report.labels).toContain("More actions");
		await expectReachable(page, report, [
			{ inline: "Reply", menu: "Reply" },
			{ inline: "Report spam", menu: "Report spam" },
		]);
	});
});
