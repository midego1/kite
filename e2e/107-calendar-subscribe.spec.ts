import { expect, request, test, type APIRequestContext, type Page } from "@playwright/test";
import { AUTO_READ_ACCOUNT_PASSWORD, createSignedInAccount, okJson } from "./support/auto-read";
import { BASE_URL, STORAGE_STATE } from "./support/constants";
import { apiContext, uniqueToken } from "./support/helpers";

let admin: APIRequestContext;
/** A subscribing calendar app: no session cookie, no headers, only the link. */
let calendarApp: APIRequestContext;

test.beforeAll(async () => {
	admin = await apiContext(STORAGE_STATE);
	calendarApp = await request.newContext({ baseURL: BASE_URL });
});

test.afterAll(async () => {
	await admin.delete("/api/calendar/feed");
	await admin.dispose();
	await calendarApp.dispose();
});

async function openSubscribe(page: Page) {
	// The header is drawn after hydration; until then neither the icon nor the menu exists.
	await expect(page.getByRole("button", { name: "New event" })).toBeVisible();
	const subscribe = page.getByRole("button", { name: "Subscribe from another calendar app" });
	if (await subscribe.isVisible()) await subscribe.click();
	else {
		await page.getByRole("button", { name: "Calendar options" }).click();
		await page.getByRole("menuitem", { name: "Subscribe…" }).click();
	}
	const dialog = page.getByRole("dialog", { name: "Subscribe from another calendar app" });
	await expect(dialog).toBeVisible();
	return dialog;
}

async function confirmIn(page: Page, title: string, button: string) {
	const confirm = page.getByRole("alertdialog", { name: title });
	await confirm.getByRole("button", { name: button }).click();
	await expect(confirm).toBeHidden();
}

test("a subscription link serves the calendar as iCalendar until it is replaced or turned off", async ({
	page,
}, testInfo) => {
	const title = `Feed standup ${uniqueToken()}`;
	const { event } = await okJson<{ event: { id: string } }>(
		await admin.post("/api/calendar/events", {
			data: {
				title,
				location: "Room 1, floor 2",
				repeat: "weekdays",
				repeatDays: [1, 3, 5],
				timeZone: "Europe/Amsterdam",
				startsAt: "2026-11-02T08:00:00.000Z",
				endsAt: "2026-11-02T08:30:00.000Z",
			},
		}),
	);
	try {
		await page.goto("/calendar");
		let dialog = await openSubscribe(page);
		await dialog.getByRole("button", { name: "Create subscription link" }).click();
		const link = dialog.getByRole("textbox", { name: "Subscription link" });
		await expect(link).toHaveValue(/\/api\/public\/calendar\/feed\/kcf_[0-9A-Za-z]{32}\.ics$/);
		await expect(dialog.getByText("Kite shows it only once")).toBeVisible();
		await expect(dialog.getByText("Google Calendar", { exact: true })).toBeVisible();
		await page.screenshot({ path: testInfo.outputPath("calendar-subscribe-created.png") });
		const first = new URL(await link.inputValue()).pathname;

		// The app fetches the link with no session and gets the events as iCalendar.
		const feed = await calendarApp.get(first);
		expect(feed.status()).toBe(200);
		expect(feed.headers()["content-type"]).toContain("text/calendar");
		expect(feed.headers()["cache-control"]).toContain("no-store");
		expect(feed.headers()["x-robots-tag"]).toContain("noindex");
		const ics = (await feed.text()).replace(/\r\n /g, "");
		expect(ics).toContain("METHOD:PUBLISH");
		expect(ics).toContain(`SUMMARY:${title}`);
		expect(ics).toContain("LOCATION:Room 1\\, floor 2");
		expect(ics).toContain("DTSTART;TZID=Europe/Amsterdam:20261102T090000");
		expect(ics).toContain("RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR");

		// The link opens the feed and nothing else: it is no API key, and Settings → API keys does not list it.
		const token = first
			.split("/")
			.pop()!
			.replace(/\.ics$/, "");
		const asKey = await calendarApp.get("/api/calendar/events", { headers: { Authorization: `Bearer ${token}` } });
		expect(asKey.status()).toBe(401);
		const { apiKeys } = await okJson<{ apiKeys: { kind: string }[] }>(await admin.get("/api/api-keys"));
		expect(apiKeys.some((key) => key.kind === "calendar_feed")).toBe(false);

		// Reopened, the dialog says a link is on but cannot show it again.
		await page.keyboard.press("Escape");
		dialog = await openSubscribe(page);
		await expect(dialog.getByText("A subscription link is on")).toBeVisible();
		await expect(dialog.getByRole("textbox", { name: "Subscription link" })).toHaveCount(0);

		// Replacing it stops the old link at once.
		await dialog.getByRole("button", { name: "Replace link" }).click();
		await confirmIn(page, "Replace the subscription link?", "Replace link");
		await expect(link).toHaveValue(/kcf_/);
		const second = new URL(await link.inputValue()).pathname;
		expect(second).not.toBe(first);
		expect((await calendarApp.get(first)).status()).toBe(404);
		expect((await calendarApp.get(second)).status()).toBe(200);

		// Turning it off stops the new one too.
		await page.keyboard.press("Escape");
		dialog = await openSubscribe(page);
		await dialog.getByRole("button", { name: "Turn off link" }).click();
		await confirmIn(page, "Turn off the subscription link?", "Turn off");
		await expect(dialog.getByRole("button", { name: "Create subscription link" })).toBeVisible();
		expect((await calendarApp.get(second)).status()).toBe(404);
	} finally {
		await admin.delete(`/api/calendar/events/${event.id}`);
	}
});

test("on a phone the dialog opens from the calendar's menu", async ({ page }, testInfo) => {
	await page.setViewportSize({ width: 375, height: 812 });
	await page.goto("/calendar");
	await expect(page.getByRole("button", { name: "Subscribe from another calendar app" })).toBeHidden();
	const dialog = await openSubscribe(page);
	await expect(dialog.getByRole("button", { name: "Create subscription link" })).toBeVisible();
	await page.screenshot({ path: testInfo.outputPath("calendar-subscribe-phone.png") });
});

test("the feed answers 404 while Calendar is off for its owner, and malformed links never reach the database", async () => {
	const account = await createSignedInAccount(admin, uniqueToken("feed"));
	try {
		const { path } = await okJson<{ path: string }>(await account.api.post("/api/calendar/feed"));
		expect((await calendarApp.get(path)).status()).toBe(200);

		await okJson(
			await admin.put(`/api/admin/accounts/${account.id}/modules`, { data: { moduleId: "calendar", allowed: false } }),
		);
		expect((await calendarApp.get(path)).status()).toBe(404);
		expect((await account.api.get("/api/calendar/feed")).status()).toBe(404);

		await okJson(
			await admin.put(`/api/admin/accounts/${account.id}/modules`, { data: { moduleId: "calendar", allowed: true } }),
		);
		expect((await calendarApp.get(path)).status()).toBe(200);
	} finally {
		await account.api.dispose();
	}
	for (const bad of ["kcf_short.ics", "ep_0123456789abcdefghijklmnopqrstuv.ics", "..%2F..%2Fapi%2Fauth%2Fme"])
		expect((await calendarApp.get(`/api/public/calendar/feed/${bad}`)).status()).toBe(404);
});

test("a new password ends the subscription link, whether the owner or an admin sets it", async () => {
	const username = uniqueToken("feedpw");
	const account = await createSignedInAccount(admin, username);
	try {
		// The owner changes their password: their own session stays, the link ends.
		const first = (await okJson<{ path: string }>(await account.api.post("/api/calendar/feed"))).path;
		expect((await calendarApp.get(first)).status()).toBe(200);
		await okJson(
			await account.api.patch("/api/settings/password", {
				data: { currentPassword: AUTO_READ_ACCOUNT_PASSWORD, newPassword: "feed-owner-new-password" },
			}),
		);
		expect((await calendarApp.get(first)).status()).toBe(404);
		expect((await account.api.get("/api/calendar/feed")).ok()).toBe(true);

		// An admin sets a password: the account is signed out everywhere and the new link ends too.
		const second = (await okJson<{ path: string }>(await account.api.post("/api/calendar/feed"))).path;
		expect((await calendarApp.get(second)).status()).toBe(200);
		await okJson(
			await admin.patch(`/api/accounts/${account.id}`, {
				data: {
					name: username,
					role: "user",
					disabled: false,
					canManageMailboxes: false,
					password: "feed-admin-set-password",
				},
			}),
		);
		expect((await calendarApp.get(second)).status()).toBe(404);
		expect((await account.api.get("/api/calendar/feed")).status()).toBe(401);
	} finally {
		await account.api.dispose();
	}
});
