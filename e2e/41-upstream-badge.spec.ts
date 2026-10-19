import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { ADMIN, STORAGE_STATE, SUPPORT_ADDRESS } from "./support/constants";
import { apiContext, deliverInbound, signIn, uniqueToken } from "./support/helpers";

type BadgeCall = ["set", number] | ["clear"];

const BADGE_CALLS_KEY = "e2e-app-badge-calls";

let api: APIRequestContext;

test.beforeAll(async () => {
	api = await apiContext(STORAGE_STATE);
});

test.afterAll(async () => {
	await api.dispose();
});

test.afterEach(async ({ page }) => {
	await page.unrouteAll({ behavior: "wait" });
});

/** Records Badging API calls in sessionStorage, so they survive the navigation to /login. */
async function stubAppBadge(page: Page) {
	await page.addInitScript((key) => {
		const record = (call: unknown[]) => {
			const calls = JSON.parse(sessionStorage.getItem(key) ?? "[]") as unknown[];
			calls.push(call);
			sessionStorage.setItem(key, JSON.stringify(calls));
			return Promise.resolve();
		};
		Object.defineProperty(navigator, "setAppBadge", {
			configurable: true,
			value: (count?: number) => record(["set", count]),
		});
		Object.defineProperty(navigator, "clearAppBadge", { configurable: true, value: () => record(["clear"]) });
	}, BADGE_CALLS_KEY);
}

async function badgeCalls(page: Page): Promise<BadgeCall[]> {
	return page.evaluate((key) => JSON.parse(sessionStorage.getItem(key) ?? "[]") as BadgeCall[], BADGE_CALLS_KEY);
}

/** The number on the app icon after the last call: 0 when cleared, null before any call. */
async function badgeValue(page: Page): Promise<number | null> {
	const last = (await badgeCalls(page)).at(-1);
	if (!last) return null;
	return last[0] === "set" ? last[1] : 0;
}

async function inboxUnread(context: APIRequestContext): Promise<number> {
	const response = await context.get("/api/messages/counts");
	expect(response.ok(), await response.text()).toBe(true);
	const data = (await response.json()) as { counts: { folders: { inbox: { unread: number } } } };
	return data.counts.folders.inbox.unread;
}

async function deliverUnread(label: string) {
	const subject = `${label} ${uniqueToken()}`;
	await deliverInbound(api, { from: `"Badge Sender" <badge@outside.test>`, to: SUPPORT_ADDRESS, subject });
	return subject;
}

function messageRow(page: Page, subject: string) {
	return page
		.getByRole("main")
		.locator("div.group")
		.filter({ has: page.getByText(subject, { exact: true }) })
		.last();
}

test("the app badge follows the Inbox unread count across all mailboxes", async ({ page }) => {
	const subject = await deliverUnread("Badge count");
	await stubAppBadge(page);
	await page.goto("/inbox");
	const row = messageRow(page, subject);
	await expect(row).toBeVisible();

	const unread = await inboxUnread(api);
	expect(unread).toBeGreaterThan(0);
	await expect.poll(() => badgeValue(page)).toBe(unread);

	await row.hover();
	await row.getByRole("button", { name: "Mark as read" }).click();
	await expect.poll(() => badgeValue(page)).toBe(unread - 1);
	expect(await inboxUnread(api)).toBe(unread - 1);

	await row.hover();
	await row.getByRole("button", { name: "Mark as unread" }).click();
	await expect.poll(() => badgeValue(page)).toBe(unread);
	// The placeholder counts shown before the first answer never cleared the badge.
	expect((await badgeCalls(page)).some((call) => call[0] === "clear")).toBe(false);
});

test("a hidden account change clears the badge and refreshes it when visible", async ({ page }) => {
	await stubAppBadge(page);
	// Keep revision replies silent: the counts hook must recover without a realtime refresh.
	await page.routeWebSocket("**/api/realtime", () => {});
	let unread = 9;
	await page.route("**/api/messages/counts*", async (route) => {
		const response = await route.fetch();
		const data = await response.json();
		data.counts.folders.inbox.unread = unread;
		await route.fulfill({ response, json: data });
	});
	await page.goto("/inbox");
	await expect.poll(() => badgeValue(page)).toBe(9);

	await page.evaluate(() => {
		Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
		window.dispatchEvent(new CustomEvent("kite:auth-session-changed", { detail: { authenticated: true } }));
	});
	await expect.poll(() => badgeValue(page)).toBe(0);

	unread = 4;
	await page.evaluate(() => {
		Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
		document.dispatchEvent(new Event("visibilitychange"));
	});
	await expect.poll(() => badgeValue(page)).toBe(4);
});

test("visible-tab refresh timers defer badge updates while hidden", async ({ page }) => {
	await stubAppBadge(page);
	await page.routeWebSocket("**/api/realtime", () => {});
	let unread = 9;
	let requests = 0;
	await page.route("**/api/messages/counts*", async (route) => {
		requests += 1;
		const response = await route.fetch();
		const data = await response.json();
		data.counts.folders.inbox.unread = unread;
		await route.fulfill({ response, json: data });
	});
	await page.goto("/inbox");
	await expect.poll(() => badgeValue(page)).toBe(9);
	await page.clock.install();

	for (const invalidateWhileHidden of [false, true]) {
		const previousRequests = requests;
		const previousBadgeCalls = await badgeCalls(page);
		unread -= 2;
		await page.evaluate((invalidate) => {
			window.dispatchEvent(new Event("kite:message-counts-changed"));
			Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
			document.dispatchEvent(new Event("visibilitychange"));
			if (invalidate) window.dispatchEvent(new Event("kite:message-counts-changed"));
		}, invalidateWhileHidden);
		await page.clock.runFor(300);
		expect(requests).toBe(previousRequests);
		expect(await badgeCalls(page)).toEqual(previousBadgeCalls);

		await page.evaluate(() => {
			Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
			document.dispatchEvent(new Event("visibilitychange"));
		});
		await page.clock.runFor(300);
		await expect.poll(() => badgeValue(page)).toBe(unread);
	}
});

test.describe("signing out", () => {
	// Signing out revokes the session, so this must not use the suite's shared admin session.
	test.use({ storageState: { cookies: [], origins: [] } });

	test("clears the app badge", async ({ page }) => {
		await deliverUnread("Badge sign-out");
		await stubAppBadge(page);
		await signIn(page, ADMIN.email, ADMIN.password);
		await expect(page).toHaveURL(/\/inbox/);
		await expect.poll(() => badgeValue(page)).toBeGreaterThan(0);

		await page.getByRole("button", { name: "Open account menu" }).click();
		await page.getByRole("button", { name: "Sign out" }).click();
		await expect(page).toHaveURL(/\/login/);
		await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
		await expect.poll(() => badgeValue(page)).toBe(0);
		expect((await badgeCalls(page)).at(-1)).toEqual(["clear"]);
	});
});
