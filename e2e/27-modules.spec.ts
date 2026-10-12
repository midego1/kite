import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { ADMIN, BASE_URL, DOMAIN, STORAGE_STATE } from "./support/constants";
import { apiContext, signIn } from "./support/helpers";
import { restoreModules, setModuleState } from "./support/modules";

async function owner(): Promise<APIRequestContext> {
	return apiContext(STORAGE_STATE);
}

async function ownerBooking(api: APIRequestContext): Promise<{ id: string; username: string }> {
	const me = await (await api.get("/api/auth/me")).json();
	const booking = await (await api.get("/api/booking")).json();
	return { id: me.user.id, username: booking.username };
}

/** A visitor with no session, which is what a person following a public booking link is. */
async function visitor(): Promise<APIRequestContext> {
	return apiContext();
}

const MEMBER_PASSWORD = "module-member-password-123";

/** A regular account with its own mailbox, signed in on a separate API client. */
async function createMember(admin: APIRequestContext) {
	const username = `member${Date.now()}${Math.floor(Math.random() * 1000)}`;
	const { domains } = await (await admin.get("/api/domains")).json();
	const created = await admin.post("/api/accounts", {
		data: {
			username,
			domainId: domains.find((item: { hostname: string }) => item.hostname === DOMAIN).id,
			password: MEMBER_PASSWORD,
			role: "user",
			useAllDomains: true,
		},
	});
	expect(created.ok(), await created.text()).toBe(true);
	const id = (await created.json()).account.id as string;
	const email = `${username}@${DOMAIN}`;
	const api = await apiContext();
	const login = await api.post("/api/auth/login", { data: { email, password: MEMBER_PASSWORD } });
	expect(login.ok(), await login.text()).toBe(true);
	return { id, email, api };
}

async function expectNotFoundPage(page: Page, path: string) {
	const response = await page.goto(path);
	expect(response?.status(), path).toBe(404);
	await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
	await expect(page.getByRole("link", { name: "Go to inbox" })).toHaveAttribute("href", "/inbox");
}

/** Opens the menu in the page header and returns it, so its links are not confused with the sidebar's. */
async function openAccountMenu(page: Page) {
	await page.goto("/inbox");
	await page.getByRole("button", { name: "Open account menu" }).click();
	const menu = page.getByRole("banner");
	await expect(menu.getByRole("link", { name: "Inbox", exact: true })).toBeVisible();
	return menu;
}

test("the session answer lists the four modules that are on for the owner", async ({ request }) => {
	const response = await request.get("/api/auth/me");
	expect(response.status()).toBe(200);
	const body = await response.json();
	expect(body.modules).toEqual(["calendar", "booking", "templates", "import"]);
});

test("the mailbox and the calendar both load with every module on", async ({ page }) => {
	await page.goto("/inbox");
	await expect(page.getByRole("button", { name: "Compose" })).toBeVisible();
	await page.goto("/calendar");
	await expect(page).toHaveURL(/\/calendar/);
	await expect(page.getByText("Page not found")).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Today" })).toBeVisible();
	const tabs = page.getByRole("navigation", { name: "Calendar sections" });
	await expect(tabs.getByRole("link")).toHaveText(["Bookings", "Calendar"]);
	const menu = await openAccountMenu(page);
	await expect(menu.getByRole("link", { name: "Calendar", exact: true })).toBeVisible();
	await expect(menu.getByRole("link", { name: "Booking", exact: true })).toHaveAttribute("href", "/booking");
});

test("signed-out callers keep their 401 for module routes while the modules are on", async () => {
	const anonymous = await visitor();
	try {
		for (const [method, path] of [
			["GET", "/api/calendar/events"],
			["POST", "/api/calendar/events"],
			["PATCH", "/api/calendar/events/e2e_probe"],
			["DELETE", "/api/calendar/events/e2e_probe"],
			["GET", "/api/booking"],
			["PATCH", "/api/booking/settings"],
			["GET", "/api/templates"],
			["GET", "/api/import/jobs"],
			["POST", "/api/import/messages"],
		] as const) {
			const response = await anonymous.fetch(path, { method });
			expect(response.status(), `${method} ${path}`).toBe(401);
		}
	} finally {
		await anonymous.dispose();
	}
});

test("Calendar off hides the navigation and answers not-found on pages and API for everyone", async ({ page }) => {
	const api = await owner();
	const anonymous = await visitor();
	try {
		await setModuleState(api, { modules: { calendar: false } });
		const menu = await openAccountMenu(page);
		await expect(menu.getByRole("link", { name: "Calendar", exact: true })).toHaveCount(0);
		// Booking needs Calendar, so it goes with it.
		await expect(menu.getByRole("link", { name: "Booking", exact: true })).toHaveCount(0);
		expect((await api.get("/api/auth/me").then((r) => r.json())).modules).toEqual(["templates", "import"]);

		await expectNotFoundPage(page, "/calendar");
		await expectNotFoundPage(page, "/booking");
		await expectNotFoundPage(page, `/calendar?date=${new Date().toISOString().slice(0, 10)}`);

		for (const caller of [api, anonymous]) {
			for (const [method, path] of [
				["GET", "/api/calendar/events"],
				["POST", "/api/calendar/events"],
				["PATCH", "/api/calendar/events/e2e_probe"],
				["DELETE", "/api/calendar/events/e2e_probe"],
				["GET", "/api/booking"],
			] as const) {
				const response = await caller.fetch(path, { method });
				expect(response.status(), `${method} ${path}`).toBe(404);
				expect(await response.json()).toEqual({ error: "Not found" });
			}
		}

		const signedOut = await page.context().browser()!.newContext({ baseURL: BASE_URL });
		try {
			const response = await (await signedOut.newPage()).goto("/calendar");
			expect(response?.status()).toBe(404);
		} finally {
			await signedOut.close();
		}
	} finally {
		await restoreModules(api);
		await api.dispose();
		await anonymous.dispose();
	}
	const restored = await owner();
	try {
		expect((await restored.get("/api/calendar/events")).status()).toBe(200);
	} finally {
		await restored.dispose();
	}
});

test("Booking off keeps the calendar but drops the Bookings tab, the Booking link and every booking route", async ({
	page,
}) => {
	const api = await owner();
	const anonymous = await visitor();
	try {
		await setModuleState(api, { modules: { booking: false } });
		await page.goto("/calendar");
		const tabs = page.getByRole("navigation", { name: "Calendar sections" });
		await expect(tabs.getByRole("link")).toHaveText(["Calendar"]);
		const menu = await openAccountMenu(page);
		await expect(menu.getByRole("link", { name: "Calendar", exact: true })).toBeVisible();
		await expect(menu.getByRole("link", { name: "Booking", exact: true })).toHaveCount(0);
		await expectNotFoundPage(page, "/booking");
		expect((await api.get("/api/calendar/events")).status()).toBe(200);

		for (const caller of [api, anonymous]) {
			for (const [method, path] of [
				["GET", "/api/booking"],
				["POST", "/api/booking"],
				["PATCH", "/api/booking/e2e_probe"],
				["DELETE", "/api/booking/e2e_probe"],
				["PATCH", "/api/booking/settings"],
			] as const) {
				const response = await caller.fetch(path, { method });
				expect(response.status(), `${method} ${path}`).toBe(404);
				expect(await response.json()).toEqual({ error: "Not found" });
			}
		}
	} finally {
		await restoreModules(api);
		await api.dispose();
		await anonymous.dispose();
	}
});

test("Booking off answers not-found on the public pages and the public API, then they return", async ({ browser }) => {
	const api = await owner();
	const anonymous = await visitor();
	const guest = await browser.newContext({ baseURL: BASE_URL, storageState: undefined });
	try {
		const host = await ownerBooking(api);
		const pages = [
			`/book/${host.id}`,
			`/book/${host.id}/e2e_probe`,
			`/c/${host.username}`,
			`/c/${host.username}/e2e_probe`,
		];
		const publicApi = [
			`/api/public/booking?username=${host.username}`,
			`/api/public/booking/e2e_probe?username=${host.username}`,
		];

		await setModuleState(api, { modules: { booking: false } });
		for (const path of pages) {
			const page = await guest.newPage();
			const response = await page.goto(path);
			expect(response?.status(), path).toBe(404);
			await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
			await page.close();
		}
		for (const path of publicApi) {
			const response = await anonymous.get(path);
			expect(response.status(), path).toBe(404);
			expect(await response.json()).toEqual({ error: "Not found" });
		}
		const post = await anonymous.post(publicApi[1], { data: { name: "A", email: "a@example.net", startsAt: "x" } });
		expect(post.status()).toBe(404);

		await restoreModules(api);
		expect((await anonymous.get(publicApi[0])).status()).toBe(200);
		// The documented public answers are unchanged while the module is on.
		expect((await anonymous.get("/api/public/booking")).status()).toBe(400);
		expect((await anonymous.get("/api/public/booking/e2e_probe")).status()).toBe(404);
		const page = await guest.newPage();
		const response = await page.goto(`/c/${host.username}`);
		expect(response?.status()).toBe(200);
		await expect(page.getByRole("heading", { name: /Book a meeting/ })).toBeVisible();
	} finally {
		await restoreModules(api);
		await guest.close();
		await api.dispose();
		await anonymous.dispose();
	}
});

test("a restricted host's public booking pages answer 404 while other hosts keep theirs", async ({ browser }) => {
	const api = await owner();
	const anonymous = await visitor();
	const guest = await browser.newContext({ baseURL: BASE_URL, storageState: undefined });
	let restricted: string | null = null;
	let memberApi: APIRequestContext | null = null;
	try {
		const member = await createMember(api);
		restricted = member.id;
		memberApi = member.api;
		const { username } = (await (await member.api.get("/api/booking")).json()) as { username: string };
		await setModuleState(api, { access: [{ userId: member.id, moduleId: "booking", allowed: false }] });

		expect((await (await guest.newPage()).goto(`/book/${member.id}`))?.status()).toBe(404);
		expect((await (await guest.newPage()).goto(`/c/${username}`))?.status()).toBe(404);
		expect((await anonymous.get(`/api/public/booking?userId=${member.id}`)).status()).toBe(404);
		expect((await anonymous.get(`/api/public/booking?username=${username}`)).status()).toBe(404);
		expect((await member.api.get("/api/booking")).status()).toBe(404);

		const host = await ownerBooking(api);
		expect((await anonymous.get(`/api/public/booking?username=${host.username}`)).status()).toBe(200);
		expect((await (await guest.newPage()).goto(`/book/${host.id}`))?.status()).toBe(200);
	} finally {
		await restoreModules(api, restricted ? [restricted] : []);
		await guest.close();
		await memberApi?.dispose();
		await api.dispose();
		await anonymous.dispose();
	}
});

test("the not-found page is a styled 404 card in Kite, Classic and dark mode", async ({ page }) => {
	const response = await page.goto("/this-page-does-not-exist-e2e");
	expect(response?.status()).toBe(404);
	const card = page.getByRole("heading", { name: "Page not found" });
	await expect(card).toBeVisible();
	const link = page.getByRole("link", { name: "Go to inbox" });
	// Computed colours may come back in any CSS colour space; a one-pixel canvas turns them into plain RGB.
	const colors = async () =>
		page.evaluate(() => {
			const context = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
			const rgb = (css: string) => {
				context.clearRect(0, 0, 1, 1);
				context.fillStyle = css;
				context.fillRect(0, 0, 1, 1);
				return Array.from(context.getImageData(0, 0, 1, 1).data.slice(0, 3));
			};
			const anchor = document.querySelector('a[href="/inbox"]') as HTMLElement;
			const panel = anchor.parentElement as HTMLElement;
			return {
				link: rgb(getComputedStyle(anchor).backgroundColor),
				panel: rgb(getComputedStyle(panel).backgroundColor),
				text: rgb(getComputedStyle(panel.querySelector("h1")!).color),
			};
		});
	const set = (style: "kite" | "classic", dark: boolean) =>
		page.evaluate(
			([nextStyle, nextDark]) => {
				document.documentElement.dataset.style = nextStyle as string;
				document.documentElement.classList.toggle("dark", nextDark as boolean);
			},
			[style, dark],
		);
	const luminance = ([r, g, b]: number[]) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

	await set("kite", false);
	const kite = await colors();
	await set("classic", false);
	const classic = await colors();
	await set("kite", true);
	const dark = await colors();

	expect(kite.link, "Kite accent differs from Classic blue").not.toEqual(classic.link);
	expect(Math.abs(luminance(kite.panel) - luminance(kite.text))).toBeGreaterThan(0.4);
	expect(Math.abs(luminance(classic.panel) - luminance(classic.text))).toBeGreaterThan(0.4);
	expect(luminance(dark.panel)).toBeLessThan(0.35);
	expect(Math.abs(luminance(dark.panel) - luminance(dark.text))).toBeGreaterThan(0.4);
	await expect(link).toBeVisible();
	await link.click();
	await expect(page).toHaveURL(/\/inbox/);
});

test("Import off hides it from Settings and answers not-found on its page and API, and the old links go to Export", async ({
	page,
}) => {
	const api = await owner();
	const anonymous = await visitor();
	try {
		await page.goto("/settings/account");
		const menu = page.getByRole("complementary", { name: "Settings menu" });
		await expect(menu.getByRole("link", { name: "Import" })).toBeVisible();
		await expect(menu.getByRole("link", { name: "Export" })).toBeVisible();
		await page.goto("/import-export");
		await expect(page).toHaveURL(/\/settings\/import$/);

		await setModuleState(api, { modules: { import: false } });
		await page.goto("/settings/account");
		await expect(menu.getByRole("link", { name: "Export" })).toBeVisible();
		await expect(menu.getByRole("link", { name: "Import" })).toHaveCount(0);
		await expectNotFoundPage(page, "/settings/import");

		for (const caller of [api, anonymous]) {
			const jobs = await caller.get("/api/import/jobs");
			expect(jobs.status()).toBe(404);
			expect(await jobs.json()).toEqual({ error: "Not found" });
			expect((await caller.post("/api/import/messages")).status()).toBe(404);
			expect((await caller.post("/api/import/imap/folders", { data: {} })).status()).toBe(404);
		}

		await page.goto("/import-export");
		await expect(page).toHaveURL(/\/settings\/export$/);
		await page.goto("/settings/import-export");
		await expect(page).toHaveURL(/\/settings\/export$/);
	} finally {
		await restoreModules(api);
		await api.dispose();
		await anonymous.dispose();
	}
	const restored = await owner();
	try {
		expect((await restored.get("/api/import/jobs")).status()).toBe(200);
		await page.goto("/settings/import-export");
		await expect(page).toHaveURL(/\/settings\/import$/);
	} finally {
		await restored.dispose();
	}
});

test("Export works for the owner while Mail import is off", async ({ page }) => {
	const api = await owner();
	try {
		const { mailboxes } = await (await api.get("/api/mailboxes")).json();
		const support = mailboxes.find((item: { localPart: string }) => item.localPart === "support");
		expect(support, "seeded support mailbox").toBeDefined();
		await setModuleState(api, { modules: { import: false } });

		await page.goto("/settings/export");
		await expect(page.getByRole("button", { name: "Download .mbox" })).toBeVisible();
		await expect(page.getByText("Page not found")).toHaveCount(0);

		const download = await api.get(`/api/export/messages?mailboxId=${support.id}`);
		expect(download.status()).toBe(200);
		expect(download.headers()["content-type"]).toContain("application/mbox");
		const body = await download.text();
		expect(body).toMatch(/^From /m);
		expect(body).toMatch(/^Subject: /m);
	} finally {
		await restoreModules(api);
		await api.dispose();
	}
});

test("a user restricted from Mail import loses it while the owner keeps it, and Export stays", async ({ browser }) => {
	const api = await owner();
	let memberId: string | null = null;
	let memberApi: APIRequestContext | null = null;
	const memberContext = await browser.newContext({ baseURL: BASE_URL, storageState: undefined });
	try {
		const member = await createMember(api);
		memberId = member.id;
		memberApi = member.api;
		expect((await member.api.get("/api/import/jobs")).status()).toBe(200);

		await setModuleState(api, { access: [{ userId: member.id, moduleId: "import", allowed: false }] });
		expect((await member.api.get("/api/import/jobs")).status()).toBe(404);
		expect((await member.api.post("/api/import/messages")).status()).toBe(404);
		expect((await api.get("/api/import/jobs")).status()).toBe(200);
		expect((await (await member.api.get("/api/auth/me")).json()).modules).not.toContain("import");

		const memberPage = await memberContext.newPage();
		await signIn(memberPage, member.email, MEMBER_PASSWORD);
		await expect(memberPage).toHaveURL(/\/inbox/);
		await memberPage.goto("/settings/account");
		const menu = memberPage.getByRole("complementary", { name: "Settings menu" });
		await expect(menu.getByRole("link", { name: "Export" })).toBeVisible();
		await expect(menu.getByRole("link", { name: "Import" })).toHaveCount(0);
		await expectNotFoundPage(memberPage, "/settings/import");
		await memberPage.goto("/import-export");
		await expect(memberPage).toHaveURL(/\/settings\/export$/);
	} finally {
		await restoreModules(api, memberId ? [memberId] : []);
		await memberContext.close();
		await memberApi?.dispose();
		await api.dispose();
	}
});
