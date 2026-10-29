import { expect, test, type Browser, type Page } from "@playwright/test";
import { STORAGE_STATE } from "../../e2e/support/constants";
import { createFolder, createLink, uploadFile } from "../../e2e/support/drive";
import { apiContext } from "../../e2e/support/helpers";
import { seedDemoData } from "./demo-data";

// The pages around the app: sign-in, password reset, not-found, a public booking link, a public Drive link and a
// shared dialog, as screenshots/public/<name>.png (a 1440x900 window at 1x, or 390x844 on a phone).
test.describe.configure({ mode: "serial" });

test.beforeAll(seedDemoData);

type Appearance = { theme?: string; phone?: boolean; signedOut?: boolean };

async function open(browser: Browser, { theme = "light", phone = false, signedOut = false }: Appearance = {}) {
	const context = await browser.newContext({
		storageState: signedOut ? { cookies: [], origins: [] } : STORAGE_STATE,
		viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 },
		...(phone ? { deviceScaleFactor: 2, isMobile: true, hasTouch: true } : {}),
		colorScheme: theme === "dark" ? "dark" : "light",
	});
	await context.addInitScript((nextTheme) => {
		localStorage.removeItem("kite-style");
		localStorage.setItem("kite-theme", nextTheme);
	}, theme);
	return context.newPage();
}

async function capture(page: Page, name: string) {
	await expect(page.getByRole("progressbar", { name: "Loading page" })).toHaveCount(0);
	// The first-load splash fades out over 300 ms once the page has its data.
	const overlay = page.locator("[data-loading-overlay]");
	if (await overlay.count()) await expect(overlay).toHaveCSS("opacity", "0");
	await page.waitForLoadState("networkidle");
	await page.evaluate(() => document.fonts.ready);
	await page.screenshot({ path: `screenshots/${name}.png`, animations: "disabled", caret: "hide" });
	await page.context().close();
}

// Signed-out pages: sign-in, password reset and not-found.
for (const [name, path, ready, appearance] of [
	["login", "/login", "Forgot password?", { signedOut: true }],
	["login-dark", "/login", "Forgot password?", { signedOut: true, theme: "dark" }],
	["login-phone", "/login", "Forgot password?", { signedOut: true, phone: true }],
	["forgot-password", "/forgot-password", "Send reset link", { signedOut: true }],
	["not-found", "/no-such-page", "Page not found", {}],
	["not-found-dark", "/no-such-page", "Page not found", { theme: "dark" }],
] as const) {
	test(name, async ({ browser }) => {
		const page = await open(browser, appearance);
		await page.goto(path);
		await expect(page.getByText(ready, { exact: false }).first()).toBeVisible();
		await capture(page, `public/${name}`);
	});
}

/** Turns the demo meeting on or off from the Bookings page, as its owner would; true when it changed. */
async function setMeeting(browser: Browser, enabled: boolean): Promise<boolean> {
	const page = await open(browser);
	await page.goto("/booking");
	const event = page.locator("article", { hasText: MEETING });
	await expect(event).toBeVisible({ timeout: 120_000 });
	const isOn = (await event.getByRole("button", { name: "Turn on" }).count()) === 0;
	if (isOn !== enabled) {
		const saved = page.waitForResponse(
			(response) => response.url().includes("/api/booking") && response.request().method() !== "GET",
		);
		if (enabled) await event.getByRole("button", { name: "Turn on" }).click();
		else {
			await event.getByRole("button", { name: `More options for ${MEETING}` }).click();
			await event.getByRole("button", { name: "Turn off" }).click();
		}
		await saved;
	}
	await expect(event.getByRole("button", { name: "Turn on" })).toHaveCount(enabled ? 0 : 1);
	await page.context().close();
	return isOn !== enabled;
}

const MEETING = "30 Minute Meeting";
const FOLDER = "Launch kit";

// What a visitor sees from a booking link and a Drive link. Everything it adds to the shared demo account (the
// folder, its files and link, the meeting it turns on) is removed again, so the README shots never show it.
test("public booking and Drive pages", async ({ browser }) => {
	const api = await apiContext(STORAGE_STATE);
	let turnedOn = false;
	let folderId: string | null = null;
	let linkId: string | null = null;
	try {
		turnedOn = await setMeeting(browser, true);
		const me = (await (await api.get("/api/auth/me")).json()) as { user: { id: string } };
		const booking = (await (await api.get("/api/booking")).json()) as {
			username: string;
			events: { id: string; name: string }[];
		};
		const meeting = booking.events.find((item) => item.name === MEETING)!;
		const folder = await createFolder(api, FOLDER);
		folderId = folder.id;
		await uploadFile(api, "launch-plan.txt", "Launch plan", { parentId: folder.id });
		await uploadFile(api, "rollout-checklist.csv", "step,owner", { contentType: "text/csv", parentId: folder.id });
		const { link, token } = await createLink(api, folder.id);
		linkId = link.id;

		for (const [name, path, ready, appearance] of [
			["booking", `/c/${booking.username}`, MEETING, {}],
			["booking-event", `/book/${me.user.id}/${meeting.id}`, MEETING, {}],
			["booking-event-dark", `/book/${me.user.id}/${meeting.id}`, MEETING, { theme: "dark" }],
			["booking-event-phone", `/book/${me.user.id}/${meeting.id}`, MEETING, { phone: true }],
			["drive-link", `/d/${token}`, "launch-plan.txt", {}],
			["drive-link-dark", `/d/${token}`, "launch-plan.txt", { theme: "dark" }],
		] as const) {
			const page = await open(browser, { ...appearance, signedOut: true });
			await page.goto(path);
			// Public pages compile on their first visit in a dev server.
			await expect(page.getByText(ready, { exact: false }).first()).toBeVisible({ timeout: 120_000 });
			await capture(page, `public/${name}`);
		}
	} finally {
		if (linkId) expect((await api.delete(`/api/drive/links/${linkId}`)).ok()).toBe(true);
		if (folderId) {
			for (const action of ["trash", "delete"])
				expect((await api.post("/api/drive/items/bulk", { data: { ids: [folderId], action } })).ok()).toBe(true);
		}
		await api.dispose();
		if (turnedOn) await setMeeting(browser, false);
	}
});

// A shared dialog with a form.
for (const [name, appearance] of [
	["dialog-new-mailbox", {}],
	["dialog-new-mailbox-dark", { theme: "dark" }],
] as const) {
	test(name, async ({ browser }) => {
		const page = await open(browser, appearance);
		await page.goto("/mailboxes");
		await page.getByRole("button", { name: "New mailbox" }).first().click();
		await expect(page.getByRole("dialog")).toBeVisible();
		await capture(page, `public/${name}`);
	});
}
