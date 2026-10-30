import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { apiContext } from "./support/helpers";
import { STORAGE_STATE } from "./support/constants";

/** Set to a directory to save the rail's screenshots there (the PR's before and after). */
const SHOT_DIR = process.env.RAIL_SHOT_DIR;

const FOLDER_COLORS = [
	{ name: "Rail default", color: "#2563eb" },
	{ name: "Rail custom", color: "#dc2626" },
];

const VARIANTS = [
	{ name: "kite-light", style: "kite", theme: "light" },
	{ name: "kite-dark", style: "kite", theme: "dark" },
	{ name: "classic-light", style: "classic", theme: "light" },
	{ name: "classic-dark", style: "classic", theme: "dark" },
];

type Box = { x: number; y: number; width: number; height: number };

async function ensureFolders() {
	const api = await apiContext(STORAGE_STATE);
	const { mailboxes } = (await (await api.get("/api/mailboxes")).json()) as { mailboxes: { id: string }[] };
	const mailboxId = mailboxes[0].id;
	const existing = (await (await api.get(`/api/folders?mailboxId=${mailboxId}`)).json()) as {
		folders: { name: string }[];
	};
	for (const { name, color } of FOLDER_COLORS) {
		if (existing.folders.some((folder) => folder.name === name)) continue;
		const created = await api.post("/api/folders", { data: { mailboxId, name, color } });
		expect(created.ok(), await created.text()).toBe(true);
	}
	await api.dispose();
}

/** Inbox and Drafts show a count, Inbox past 99, so the rail's badge has its longest label. */
async function mockCounts(page: Page) {
	await page.route(
		(url) => url.pathname === "/api/messages/counts",
		async (route) => {
			const response = await route.fetch();
			const body = (await response.json()) as {
				counts: { folders: Record<string, { total: number; unread: number }> };
			};
			body.counts.folders.inbox = { total: 150, unread: 150 };
			body.counts.folders.drafts = { total: 3, unread: 3 };
			await route.fulfill({ response, json: body });
		},
	);
}

async function openRail(page: Page, variant: (typeof VARIANTS)[number]) {
	await page.addInitScript(({ style, theme }) => {
		localStorage.setItem("kite-style", style);
		localStorage.setItem("kite-theme", theme);
	}, variant);
	await mockCounts(page);
	await page.setViewportSize({ width: 1280, height: 900 });
	await page.goto("/inbox");
	const nav = page.getByRole("navigation").first();
	// The toggle sits in the message list header while the sidebar is expanded.
	const collapse = page.getByRole("button", { name: "Collapse menu" });
	const expand = nav.getByRole("button", { name: "Expand menu" });
	// A click before hydration does nothing, so click again until the rail shows.
	await expect(async () => {
		if (await collapse.isVisible()) await collapse.click();
		await expect(expand).toBeVisible({ timeout: 1_500 });
	}).toPass({ timeout: 30_000 });
	await expect(nav.getByRole("link", { name: "Rail custom" })).toBeVisible();
	await expect(nav.getByRole("link", { name: "Inbox" })).toBeVisible();
	return nav;
}

const box = async (locator: ReturnType<Page["locator"]>): Promise<Box> => (await locator.boundingBox())!;

for (const variant of VARIANTS) {
	test(`the collapsed rail keeps every item on one axis at one size (${variant.name})`, async ({ page }) => {
		await ensureFolders();
		const nav = await openRail(page, variant);
		if (SHOT_DIR) {
			mkdirSync(SHOT_DIR, { recursive: true });
			await page.mouse.move(700, 450);
			await nav.screenshot({ path: `${SHOT_DIR}/rail-${variant.name}.png` });
		}
		const items = nav.locator("a:visible, button:visible");
		const count = await items.count();
		expect(count).toBeGreaterThanOrEqual(10);

		const rows: { label: string; box: Box; icon: Box | null }[] = [];
		for (let index = 0; index < count; index++) {
			const item = items.nth(index);
			const label = (await item.getAttribute("aria-label")) ?? (await item.innerText());
			const svg = item.locator("svg").first();
			rows.push({
				label,
				box: await box(item),
				icon: (await svg.count()) ? await box(svg) : null,
			});
		}

		const centres = rows.map((row) => row.box.x + row.box.width / 2);
		const [firstCentre] = centres;
		const named = (label: string) => rows.find((row) => row.label === label)!;
		for (const [index, row] of rows.entries()) {
			expect(row.label, "every rail item has an accessible name for its tooltip").not.toBe("");
			expect(Math.abs(centres[index] - firstCentre), `${row.label} centre x`).toBeLessThanOrEqual(0.5);
			expect(row.box.width, `${row.label} width`).toBeCloseTo(40, 0);
			expect(row.box.height, `${row.label} height`).toBeCloseTo(40, 0);
		}

		// One icon size, and every icon centred in its square.
		const icons = rows.filter((row) => row.icon && row.label !== "Open account menu");
		for (const row of icons) {
			expect(row.icon!.width, `${row.label} icon width`).toBeCloseTo(18, 0);
			expect(row.icon!.height, `${row.label} icon height`).toBeCloseTo(18, 0);
			expect(Math.abs(row.icon!.x + row.icon!.width / 2 - (row.box.x + row.box.width / 2))).toBeLessThanOrEqual(0.5);
			expect(Math.abs(row.icon!.y + row.icon!.height / 2 - (row.box.y + row.box.height / 2))).toBeLessThanOrEqual(0.5);
		}

		// An even rhythm inside a group: the gap between the folder links equals the gap between the main links.
		const gap = (a: string, b: string) => named(b).box.y - (named(a).box.y + named(a).box.height);
		expect(Math.abs(gap("Starred", "Snoozed") - gap("Snoozed", "Sent"))).toBeLessThanOrEqual(0.5);
		expect(Math.abs(gap("Rail custom", "Rail default") - gap("Starred", "Snoozed"))).toBeLessThanOrEqual(0.5);

		// The "99+" badge is a small pill at the top right that stays clear of the glyph.
		const inbox = nav.getByRole("link", { name: "Inbox" });
		const badge = inbox.getByText("99+", { exact: true });
		await expect(badge).toBeVisible();
		const badgeBox = await box(badge);
		const glyph = await box(inbox.locator("svg"));
		const overlaps =
			badgeBox.x < glyph.x + glyph.width &&
			badgeBox.x + badgeBox.width > glyph.x &&
			badgeBox.y < glyph.y + glyph.height &&
			badgeBox.y + badgeBox.height > glyph.y;
		expect(overlaps, "the badge does not cover the glyph").toBe(false);
		expect(badgeBox.height).toBeLessThanOrEqual(18);
		expect(badgeBox.y + badgeBox.height / 2).toBeLessThan(named("Inbox").box.y + 12);
		expect(badgeBox.x + badgeBox.width / 2).toBeGreaterThan(centres[0]);

		// The default folder colour is not a choice, so it stays as neutral as the system folders; a chosen one tints.
		const iconColor = (name: string) =>
			nav
				.getByRole("link", { name })
				.locator("svg")
				.evaluate((svg) => getComputedStyle(svg).color);
		expect(await iconColor("Rail default")).toBe(await iconColor("Starred"));
		expect(await iconColor("Rail custom")).toBe("rgb(220, 38, 38)");

		// The active item is the same square as the others.
		const active = nav.getByRole("link", { name: "Inbox" });
		await expect(active).toHaveClass(/bg-blue-100/);
		const activeBox = await box(active);
		expect(activeBox.width).toBeCloseTo(40, 0);
		expect(activeBox.height).toBeCloseTo(40, 0);

		// A tooltip on hover.
		await nav.getByRole("link", { name: "Starred" }).hover();
		await expect(page.getByRole("tooltip", { name: "Starred" })).toBeVisible();
	});
}
