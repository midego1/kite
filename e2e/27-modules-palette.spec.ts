import { expect, test, type Locator, type Page } from "@playwright/test";
import { restoreModules, setModuleState } from "./support/modules";
import { PALETTE_PLACEHOLDER, openPalette } from "./support/module-flows";
import { expectEveryModuleOn, owner } from "./support/module-spec";

async function runPaletteCommand(page: Page, query: string) {
	const search = await openPalette(page);
	await search.fill(query);
	await expect(page.getByRole("option", { name: new RegExp(query, "i") }).first()).toBeVisible();
	await search.press("Enter");
}

test("the palette lists core and module commands and each navigation command navigates", async ({ page }) => {
	await page.goto("/inbox");
	await expect(page.getByRole("button", { name: "Compose" })).toBeVisible();
	await openPalette(page);
	const titles = [
		"Compose new message",
		"Go to Inbox",
		"Go to Starred",
		"Go to Snoozed",
		"Go to Sent",
		"Go to Drafts",
		"Go to Archived",
		"Go to Spam",
		"Go to Trash",
		"Go to For you",
		"Go to Activity",
		"Go to Settings",
		"Account Settings",
		"Keyboard Shortcuts Cheat Sheet",
		"Export mail",
		"Open Calendar",
		"Go to a date in Calendar",
		"New event",
		"Open Booking",
		"Open a booking event type",
		"Copy booking link",
		"Import mail",
	];
	for (const title of titles) await expect(page.getByText(title, { exact: true }), title).toBeVisible();
	await expect(page.getByTestId("command-palette").getByText("C", { exact: true })).toBeVisible();
	await page.keyboard.press("Escape");

	const routes: [string, RegExp][] = [
		["Go to Sent", /\/sent$/],
		["Open Calendar", /\/calendar$/],
		["Open Booking", /\/booking$/],
		["Import mail", /\/settings\/import$/],
		["Export mail", /\/settings\/export$/],
		["Go to Inbox", /\/inbox$/],
	];
	for (const [title, path] of routes) {
		await runPaletteCommand(page, title);
		await expect(page, title).toHaveURL(path);
		await expect(page.getByText("Page not found")).toHaveCount(0);
	}
});

test("a command with a parameter asks for it, refuses a bad value and navigates with a good one", async ({ page }) => {
	await page.goto("/inbox");
	await expect(page.getByRole("button", { name: "Compose" })).toBeVisible();
	await runPaletteCommand(page, "Go to a date in Calendar");
	const date = page.getByPlaceholder("YYYY-MM-DD");
	await date.fill("tomorrow");
	await date.press("Enter");
	await expect(page.getByRole("alert")).toContainText("date");
	await expect(page).toHaveURL(/\/inbox$/);
	await date.fill("2031-03-04");
	await date.press("Enter");
	await expect(page).toHaveURL(/\/calendar$/);
	await expect(page.getByText(/March 2031/).first()).toBeVisible();
});

test("the client commands run: New event opens the dialog on the calendar", async ({ page }) => {
	await page.goto("/inbox");
	await expect(page.getByRole("button", { name: "Compose" })).toBeVisible();
	await runPaletteCommand(page, "New event");
	await expect(page).toHaveURL(/\/calendar$/);
	await expect(page.getByRole("dialog")).toBeVisible();
});

/** Moves the highlight with ArrowDown until the row with this title is highlighted. */
async function arrowToPaletteRow(page: Page, search: Locator, title: string) {
	const row = page.getByRole("option", { name: new RegExp(`^${title}`) });
	await expect(row).toBeVisible();
	for (let step = 0; step < 150; step++) {
		if ((await row.getAttribute("aria-selected")) === "true") return;
		await search.press("ArrowDown");
	}
	throw new Error(`The palette never highlighted ${title}`);
}

test("with an empty query ArrowDown and Enter run exactly the highlighted command, in every group", async ({
	page,
}) => {
	await page.goto("/inbox");
	await expect(page.getByRole("button", { name: "Compose" })).toBeVisible();
	const targets: [string, RegExp][] = [
		["Go to For you", /\/for-you$/],
		["Go to Activity", /\/kite-activity$/],
		// /settings redirects to /settings/account, so either URL can be the one the check sees.
		["Go to Settings", /\/settings(\/account)?$/],
		["Open Calendar", /\/calendar$/],
		["Open Booking", /\/booking$/],
		["Export mail", /\/settings\/export$/],
		["Account Settings", /\/settings\/account$/],
	];
	for (const [title, path] of targets) {
		const search = await openPalette(page);
		await expect(search).toHaveValue("");
		await arrowToPaletteRow(page, search, title);
		await search.press("Enter");
		await expect(page, title).toHaveURL(path);
		await expect(page.getByText("Page not found")).toHaveCount(0);
	}
});

test("ArrowUp from the first row wraps to the last row and Enter runs that command", async ({ page }) => {
	await page.goto("/inbox");
	await expect(page.getByRole("button", { name: "Compose" })).toBeVisible();
	const search = await openPalette(page);
	const rows = page.getByRole("listbox", { name: "Results" }).getByRole("option");
	await expect(rows.first()).toHaveAttribute("aria-selected", "true");
	await search.press("ArrowUp");
	const last = rows.last();
	await expect(last).toHaveAttribute("aria-selected", "true");
	const title = (await last.locator("[data-palette-title]").innerText()).trim();
	expect(title.length).toBeGreaterThan(0);
	await search.press("Enter");
	await expect(page.getByPlaceholder(PALETTE_PLACEHOLDER)).toHaveCount(0);
});

test("Calendar off removes the calendar and booking commands from every palette and they return when it is on", async ({
	page,
}) => {
	const api = await owner();
	try {
		for (const path of ["/inbox", "/settings/account", "/calendar"]) {
			await page.goto(path);
			const search = await openPalette(page);
			await search.fill("calendar");
			await expect(page.getByText("Open Calendar", { exact: true })).toBeVisible();
			await search.fill("booking");
			await expect(page.getByText("Open Booking", { exact: true })).toBeVisible();
		}

		await setModuleState(api, { modules: { calendar: false } });
		for (const path of ["/inbox", "/settings/account"]) {
			await page.goto(path);
			const search = await openPalette(page);
			for (const [query, title] of [
				["calendar", "Open Calendar"],
				["booking", "Open Booking"],
			]) {
				await search.fill(query);
				// Settings pages and mail may still match the word; the module's commands must not.
				await expect(page.getByRole("listbox", { name: "Results" })).not.toHaveAttribute("aria-busy", "true");
				await expect(page.getByText(title, { exact: true }), `${path} ${query}`).toHaveCount(0);
			}
			await search.fill("go to");
			await expect(page.getByText("Go to Inbox", { exact: true })).toBeVisible();
			await expect(page.getByText("Export mail")).toHaveCount(0);
			await search.fill("export");
			await expect(page.getByText("Export mail", { exact: true })).toBeVisible();
			await page.keyboard.press("Escape");
			// The hotkey buffer keeps the Control press for 800 ms, which would join the g s sequence.
			await page.waitForTimeout(900);
			await page.keyboard.press("g");
			await page.keyboard.press("s");
			await expect(page).toHaveURL(/\/starred$/);
		}
	} finally {
		await restoreModules(api);
		await api.dispose();
	}
	await page.goto("/inbox");
	const search = await openPalette(page);
	await search.fill("calendar");
	await expect(page.getByText("Open Calendar", { exact: true })).toBeVisible();
});

test("Booking off removes only the booking commands", async ({ page }) => {
	const api = await owner();
	try {
		await setModuleState(api, { modules: { booking: false } });
		await page.goto("/inbox");
		const search = await openPalette(page);
		await search.fill("booking");
		await expect(page.getByRole("listbox", { name: "Results" })).not.toHaveAttribute("aria-busy", "true");
		await expect(page.getByText("Open Booking", { exact: true })).toHaveCount(0);
		await search.fill("calendar");
		await expect(page.getByText("Open Calendar", { exact: true })).toBeVisible();
	} finally {
		await restoreModules(api);
		await api.dispose();
	}
});

test("Import off removes the import command, Export stays and opens its page", async ({ page }) => {
	const api = await owner();
	try {
		await setModuleState(api, { modules: { import: false } });
		await page.goto("/inbox");
		const search = await openPalette(page);
		await search.fill("import");
		await expect(page.getByRole("listbox", { name: "Results" })).not.toHaveAttribute("aria-busy", "true");
		await expect(page.getByText("Import mail", { exact: true })).toHaveCount(0);
		await search.fill("export");
		await expect(page.getByText("Export mail", { exact: true })).toBeVisible();
		await search.press("Enter");
		await expect(page).toHaveURL(/\/settings\/export$/);
		await expect(page.getByText("Page not found")).toHaveCount(0);
	} finally {
		await restoreModules(api);
		await api.dispose();
	}
});

// Fails this file when one of its tests left a module off or a user restricted.
test.afterAll(async () => {
	await expectEveryModuleOn();
});
