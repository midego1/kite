import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { uniqueToken } from "./helpers";

export async function expectNotFoundPage(page: Page, path: string) {
	const response = await page.goto(path);
	expect(response?.status(), path).toBe(404);
	await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
	await expect(page.getByRole("link", { name: "Go to inbox" })).toHaveAttribute("href", "/inbox");
}

/** Opens the account menu (at the top of the sidebar) and returns it, so its links are not confused with the sidebar's. */
export async function openAccountMenu(page: Page) {
	await page.goto("/inbox");
	await page.getByRole("button", { name: "Open account menu" }).click();
	const menu = page.locator('[data-placement="sidebar"]');
	await expect(menu.getByRole("link", { name: "Inbox", exact: true })).toBeVisible();
	return menu;
}

export const PALETTE_PLACEHOLDER = "Type a command or search actions...";

/** Opens the palette with the keyboard and returns the search box. */
export async function openPalette(page: Page) {
	const search = page.getByPlaceholder(PALETTE_PLACEHOLDER);
	await expect(async () => {
		if (!(await search.isVisible())) await page.keyboard.press("Control+k");
		await expect(search).toBeVisible({ timeout: 1000 });
	}).toPass();
	return search;
}

/** Checks that the palette lists these command titles for the query (`listed`) or reports no match, then closes it. */
export async function expectPaletteCommands(page: Page, query: string, titles: string[], listed: boolean) {
	const search = await openPalette(page);
	await search.fill(query);
	if (listed) for (const title of titles) await expect(page.getByText(title, { exact: true }), title).toBeVisible();
	else {
		await expect(page.getByText(`No matching commands found for “${query}”`)).toBeVisible();
		for (const title of titles) await expect(page.getByText(title, { exact: true }), title).toHaveCount(0);
	}
	await page.keyboard.press("Escape");
	await expect(search).toHaveCount(0);
}

const MODULE_API = /^\/api\/(calendar|booking|templates|import|finance|drive)(\/|$)/;

/**
 * Records what a page does that a mail-only install must never do: answers of 500 and above, requests
 * to a module's API and console or page errors. Read the arrays after the flow.
 */
export function watchCoreTraffic(page: Page) {
	const traffic = { serverErrors: [] as string[], moduleRequests: [] as string[], consoleErrors: [] as string[] };
	page.on("request", (request) => {
		const { pathname } = new URL(request.url());
		if (MODULE_API.test(pathname)) traffic.moduleRequests.push(`${request.method()} ${pathname}`);
	});
	page.on("response", (response) => {
		if (response.status() >= 500) traffic.serverErrors.push(`${response.status()} ${new URL(response.url()).pathname}`);
	});
	page.on("console", (message) => {
		if (message.type() === "error") traffic.consoleErrors.push(`${message.text()} ${message.location().url}`.trim());
	});
	page.on("pageerror", (error) => traffic.consoleErrors.push(error.message));
	return traffic;
}

/**
 * Creates a bookable event type for the owner and books its first slot as a signed-out visitor, which
 * writes a `booking_appointments` row. Returns the event type id for cleanup.
 */
export async function bookAppointment(owner: APIRequestContext, visitor: APIRequestContext): Promise<string> {
	const { username } = (await (await owner.get("/api/booking")).json()) as { username: string };
	const slug = uniqueToken("appt").toLowerCase();
	const type = await owner.post("/api/booking", {
		data: {
			name: "Module appointment",
			slug,
			durationMinutes: 30,
			weekdays: [0, 1, 2, 3, 4, 5, 6],
			timeRanges: [{ startTime: "09:00", endTime: "17:00" }],
			timeZone: "UTC",
			enabled: true,
		},
	});
	expect(type.status(), await type.text()).toBe(200);
	const eventTypeId = ((await type.json()) as { event: { id: string } }).event.id;
	const page = `/api/public/booking/${slug}?username=${username}`;
	const { slots } = (await (await visitor.get(page)).json()) as { slots: { startsAt: string }[] };
	const booked = await visitor.post(page, {
		data: { name: "Module Booker", email: "module.booker@example.org", startsAt: slots[0]!.startsAt },
	});
	expect(booked.status(), await booked.text()).toBe(200);
	return eventTypeId;
}
