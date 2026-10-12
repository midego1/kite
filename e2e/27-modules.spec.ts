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
async function createMember(admin: APIRequestContext, role: "user" | "admin" = "user") {
	const username = `${role === "admin" ? "adminb" : "member"}${Date.now()}${Math.floor(Math.random() * 1000)}`;
	const { domains } = await (await admin.get("/api/domains")).json();
	const created = await admin.post("/api/accounts", {
		data: {
			username,
			domainId: domains.find((item: { hostname: string }) => item.hostname === DOMAIN).id,
			password: MEMBER_PASSWORD,
			role,
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

type AuditRow = { action: string; actorEmail: string | null; metadata: string | null };

async function moduleAuditRows(api: APIRequestContext): Promise<AuditRow[]> {
	const response = await api.get("/api/audit-logs?limit=200");
	expect(response.status()).toBe(200);
	const { auditLogs } = (await response.json()) as { auditLogs: AuditRow[] };
	return auditLogs.filter((row) => row.action.startsWith("module."));
}

/** How many rows exist per action and module, so a test can tell which rows its own steps added. */
function auditKeys(rows: AuditRow[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const row of rows) {
		const key = `${row.action} ${JSON.parse(row.metadata ?? "{}").moduleId}`;
		counts[key] = (counts[key] ?? 0) + 1;
	}
	return counts;
}

const moduleSection = (page: Page, name: string) => page.getByRole("region", { name, exact: true });
const moduleSwitch = (page: Page, name: string) => moduleSection(page, name).getByRole("switch");

test("the Modules page lists the four modules with their dependencies, capabilities and notes", async ({ page }) => {
	await page.goto("/modules");
	await expect(page.getByRole("heading", { level: 1, name: "Modules" })).toBeVisible();
	await expect(page.locator("[data-module] h2")).toHaveText(["Calendar", "Booking", "Email templates", "Mail import"]);
	await expect(page.getByRole("heading", { level: 2, name: "Always on" })).toBeVisible();
	await expect(page.locator("[data-module]").getByRole("switch")).toHaveCount(4);
	await expect(page.getByText("up to 30 seconds to reach other open sessions")).toBeVisible();
	await expect(moduleSection(page, "Booking")).toContainText("Depends on Calendar");
	for (const name of ["Calendar", "Email templates", "Mail import"])
		await expect(moduleSection(page, name)).not.toContainText("Depends on");
	await expect(moduleSection(page, "Mail import")).toContainText(
		"Turning this off pauses running imports. They keep their saved source credentials until they finish or are cancelled, and resume within about five minutes of turning it back on.",
	);
	const calendar = moduleSection(page, "Calendar");
	for (const item of [
		"get_schedule",
		"mcp:calendar-read",
		"mcp:calendar-write",
		"calendar:read",
		"calendar:write",
		"calendar.event.created",
		"calendar.event.updated",
		"calendar.event.deleted",
		"calendar.open",
		"calendar.go_to_date",
	])
		await expect(calendar.getByText(item, { exact: true })).toBeVisible();
	const booking = moduleSection(page, "Booking");
	for (const item of ["booking.appointment.created", "booking.open", "booking.open_event_type"])
		await expect(booking.getByText(item, { exact: true })).toBeVisible();
	await expect(moduleSection(page, "Mail import").getByText("import.open", { exact: true })).toBeVisible();
	await expect(moduleSection(page, "Email templates")).toContainText("Adds no assistant tools");
	await expect(moduleSection(page, "Calendar")).toContainText("Every user has access.");
});

test("Calendar off asks first, Booking reads Off because Calendar is off and cannot be turned on, and Calendar on restores it", async ({
	page,
}) => {
	const api = await owner();
	try {
		const before = (await moduleAuditRows(api)).length;
		await page.goto("/modules");
		await moduleSwitch(page, "Calendar").click();
		const dialog = page.getByRole("alertdialog");
		await expect(dialog).toContainText("Booking will be turned off too");
		await dialog.getByRole("button", { name: "Cancel" }).click();
		await expect(dialog).toHaveCount(0);
		expect((await (await api.get("/api/admin/modules")).json()).modules[0]).toMatchObject({
			id: "calendar",
			enabled: true,
		});
		expect(await moduleAuditRows(api)).toHaveLength(before);

		await moduleSwitch(page, "Calendar").click();
		await page.getByRole("alertdialog").getByRole("button", { name: "Turn off Calendar" }).click();
		await expect(page.getByTestId("booking-status")).toHaveText("Off because Calendar is off");
		await expect(moduleSwitch(page, "Calendar")).toHaveAttribute("aria-checked", "false");
		const stored = (await (await api.get("/api/admin/modules")).json()).modules;
		expect(stored.map((item: { id: string; enabled: boolean }) => [item.id, item.enabled])).toEqual([
			["calendar", false],
			["booking", true],
			["templates", true],
			["import", true],
		]);
		expect((await (await api.get("/api/auth/me")).json()).modules).toEqual(["templates", "import"]);

		// Booking cannot be turned on while Calendar is off: the API refuses and the page says why.
		const refused = await api.put("/api/admin/modules", { data: { moduleId: "booking", enabled: true } });
		expect(refused.status()).toBe(409);
		expect((await refused.json()).code).toBe("MODULE_DEPENDENCY");
		await moduleSwitch(page, "Booking").click();
		await expect(moduleSection(page, "Booking").getByRole("alert")).toContainText("Turn on Calendar first");
		await expect(page.getByTestId("booking-status")).toHaveText("Off because Calendar is off");
		expect(await moduleAuditRows(api)).toHaveLength(before + 1);

		await moduleSwitch(page, "Calendar").click();
		await expect(page.getByTestId("booking-status")).toHaveText("On");
		expect((await (await api.get("/api/auth/me")).json()).modules).toEqual([
			"calendar",
			"booking",
			"templates",
			"import",
		]);
		await page.goto("/booking");
		await expect(page.getByText("Page not found")).toHaveCount(0);

		// Booking off before Calendar stays off when Calendar returns.
		await setModuleState(api, { modules: { booking: false } });
		await setModuleState(api, { modules: { calendar: false } });
		await setModuleState(api, { modules: { calendar: true } });
		expect((await (await api.get("/api/auth/me")).json()).modules).toEqual(["calendar", "templates", "import"]);

		const rows = await moduleAuditRows(api);
		expect(rows.length).toBeGreaterThan(before);
		expect(rows.map((row) => row.action)).toEqual(expect.arrayContaining(["module.enabled", "module.disabled"]));
		expect(rows.every((row) => row.actorEmail === ADMIN.email)).toBe(true);
	} finally {
		await restoreModules(api);
		await api.dispose();
	}
});

test("the owner toggles Email templates and Mail import on the page, the state persists and the audit rows follow", async ({
	page,
}) => {
	const api = await owner();
	try {
		const before = auditKeys(await moduleAuditRows(api));
		await page.goto("/modules");
		for (const name of ["Email templates", "Mail import"]) {
			const toggle = moduleSwitch(page, name);
			await toggle.click();
			await expect(toggle).toHaveAttribute("aria-checked", "false");
			await page.reload();
			await expect(moduleSwitch(page, name)).toHaveAttribute("aria-checked", "false");
		}
		expect((await (await api.get("/api/auth/me")).json()).modules).toEqual(["calendar", "booking"]);
		for (const name of ["Email templates", "Mail import"]) {
			await moduleSwitch(page, name).click();
			await expect(moduleSwitch(page, name)).toHaveAttribute("aria-checked", "true");
		}
		expect((await (await api.get("/api/auth/me")).json()).modules).toEqual([
			"calendar",
			"booking",
			"templates",
			"import",
		]);

		const after = auditKeys(await moduleAuditRows(api));
		const added = Object.entries(after)
			.map(([key, count]) => [key, count - (before[key] ?? 0)] as const)
			.filter(([, count]) => count > 0)
			.sort();
		expect(added).toEqual([
			["module.disabled import", 1],
			["module.disabled templates", 1],
			["module.enabled import", 1],
			["module.enabled templates", 1],
		]);

		await page.goto("/activity");
		await expect(page.getByText("Turned off Mail import").first()).toBeVisible();
		await expect(page.getByText("Turned on Email templates").first()).toBeVisible();
	} finally {
		await restoreModules(api);
		await api.dispose();
	}
});

test("the module API refuses ids outside the four and bodies it cannot read, and core areas have no switch", async () => {
	const api = await owner();
	try {
		for (const data of [
			{ moduleId: "mail", enabled: false },
			{ moduleId: "export", enabled: false },
			{ moduleId: "calendar" },
			{ moduleId: "calendar", enabled: "no" },
			{},
		]) {
			const response = await api.put("/api/admin/modules", { data });
			expect(response.status(), JSON.stringify(data)).toBe(400);
		}
		const { modules } = await (await api.get("/api/admin/modules")).json();
		expect(modules.map((item: { id: string; enabled: boolean }) => [item.id, item.enabled])).toEqual([
			["calendar", true],
			["booking", true],
			["templates", true],
			["import", true],
		]);
		expect(modules[0]).toMatchObject({ dependsOn: [], restrictedUsers: [] });
		expect(modules[1]).toMatchObject({ dependsOn: [{ id: "calendar", name: "Calendar" }], offBecause: null });
	} finally {
		await api.dispose();
	}
});

test("a restriction applies to that user only, shows on both admin pages and is audited with a user ref", async ({
	browser,
	page,
}) => {
	const api = await owner();
	let restricted: string[] = [];
	const contexts = [await browser.newContext({ baseURL: BASE_URL, storageState: undefined })];
	try {
		const target = await createMember(api);
		const other = await createMember(api);
		restricted = [target.id];

		await page.goto(`/accounts/${target.id}/permissions`);
		const section = page.getByRole("region", { name: "Modules", exact: true });
		await expect(section).toBeVisible();
		await expect(section.getByRole("checkbox")).toHaveCount(4);
		await section.getByRole("checkbox", { name: "Allow Calendar" }).uncheck();
		await section.getByRole("button", { name: "Save module access" }).click();
		await expect(section.getByText("Module access updated")).toBeVisible();
		await page.reload();
		await expect(
			page.getByRole("region", { name: "Modules", exact: true }).getByRole("checkbox", { name: "Allow Calendar" }),
		).not.toBeChecked();

		expect((await (await target.api.get("/api/auth/me")).json()).modules).toEqual(["templates", "import"]);
		expect((await (await other.api.get("/api/auth/me")).json()).modules).toEqual([
			"calendar",
			"booking",
			"templates",
			"import",
		]);
		expect((await (await api.get("/api/auth/me")).json()).modules).toEqual([
			"calendar",
			"booking",
			"templates",
			"import",
		]);
		expect((await target.api.get("/api/calendar/events")).status()).toBe(404);
		expect((await other.api.get("/api/calendar/events")).status()).toBe(200);
		expect((await api.get("/api/calendar/events")).status()).toBe(200);

		const targetPage = await contexts[0].newPage();
		await signIn(targetPage, target.email, MEMBER_PASSWORD);
		await expect(targetPage).toHaveURL(/\/inbox/);
		const menu = await openAccountMenu(targetPage);
		await expect(menu.getByRole("link", { name: "Calendar", exact: true })).toHaveCount(0);
		await expectNotFoundPage(targetPage, "/calendar");

		await page.goto("/modules");
		await expect(moduleSection(page, "Calendar")).toContainText(`1 user is restricted: ${target.email.split("@")[0]}`);

		const rows = (await moduleAuditRows(api)).filter(
			(row) => row.action === "module.user_access" && JSON.parse(row.metadata ?? "{}").ref?.id === target.id,
		);
		expect(rows).toHaveLength(1);
		expect(JSON.parse(rows[0].metadata ?? "{}")).toEqual({
			moduleId: "calendar",
			allowed: false,
			ref: { kind: "user:user", id: target.id },
		});
		await page.goto("/activity");
		await expect(page.getByText(`Restricted ${target.email} from Calendar`).first()).toBeVisible();

		const lifted = await api.put(`/api/admin/accounts/${target.id}/modules`, {
			data: { moduleId: "calendar", allowed: true },
		});
		expect(lifted.status()).toBe(200);
		expect((await (await target.api.get("/api/auth/me")).json()).modules).toEqual([
			"calendar",
			"booking",
			"templates",
			"import",
		]);
		await moduleAccessCleanup([target, other]);
	} finally {
		await restoreModules(api, restricted);
		await Promise.all(contexts.map((context) => context.close()));
		await api.dispose();
	}
});

test("saving access on the permissions page shows in the Modules summary after link navigation, without a reload", async ({
	page,
}) => {
	const api = await owner();
	let restricted: string[] = [];
	try {
		const target = await createMember(api);
		restricted = [target.id];
		const name = target.email.split("@")[0];

		await page.goto("/modules");
		await expect(moduleSection(page, "Calendar")).toContainText("Every user has access.");
		// Everything below is client-side navigation: a reload would refetch and hide a stale cache.
		await page.evaluate(() => ((window as unknown as { __noReload: boolean }).__noReload = true));
		await page.locator('a[href="/accounts"]').first().click();
		await page.locator(`a[href="/accounts/${target.id}"]`).first().click();
		await page.locator(`a[href="/accounts/${target.id}/permissions"]`).first().click();
		const section = page.getByRole("region", { name: "Modules", exact: true });
		await section.getByRole("checkbox", { name: "Allow Calendar" }).uncheck();
		await section.getByRole("button", { name: "Save module access" }).click();
		await expect(section.getByText("Module access updated")).toBeVisible();

		await page.locator('a[href="/modules"]').first().click();
		await expect(page.getByRole("heading", { level: 1, name: "Modules" })).toBeVisible();
		await expect(moduleSection(page, "Calendar")).toContainText(`1 user is restricted: ${name}`);
		expect(await page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload)).toBe(true);

		await setModuleState(api, { access: [{ userId: target.id, moduleId: "calendar", allowed: true }] });
		await target.api.dispose();
	} finally {
		await restoreModules(api, restricted);
		await api.dispose();
	}
});

test("PATCH /api/booking/settings keeps 403 for a restricted non-admin and 401 signed out", async () => {
	const api = await owner();
	let restricted: string[] = [];
	try {
		const target = await createMember(api);
		restricted = [target.id];
		await setModuleState(api, { access: [{ userId: target.id, moduleId: "booking", allowed: false }] });
		const patch = (client: APIRequestContext) =>
			client.patch("/api/booking/settings", { data: { username: "nobody" }, headers: { Origin: BASE_URL } });
		expect((await patch(target.api)).status()).toBe(403);
		expect((await patch(await visitor())).status()).toBe(401);
		await target.api.dispose();
	} finally {
		await restoreModules(api, restricted);
		await api.dispose();
	}
});

async function moduleAccessCleanup(members: { api: APIRequestContext }[]) {
	await Promise.all(members.map((member) => member.api.dispose()));
}

test("the owner's own access cannot be restricted and the owner's permissions page has no Modules section", async ({
	page,
}) => {
	const api = await owner();
	try {
		const { user } = await (await api.get("/api/auth/me")).json();
		const refused = await api.put(`/api/admin/accounts/${user.id}/modules`, {
			data: { moduleId: "calendar", allowed: false },
		});
		expect(refused.status()).toBe(400);
		expect((await refused.json()).code).toBe("OWNER_ACCESS");
		expect((await (await api.get("/api/auth/me")).json()).modules).toEqual([
			"calendar",
			"booking",
			"templates",
			"import",
		]);
		await page.goto(`/accounts/${user.id}/permissions`);
		await expect(page.getByRole("heading", { name: "Permissions" })).toBeVisible();
		await expect(page.getByRole("region", { name: "Modules", exact: true })).toHaveCount(0);
	} finally {
		await api.dispose();
	}
});

test("a non-owner admin never sees or reaches Modules, and non-admins and signed-out callers are refused", async ({
	browser,
}) => {
	const api = await owner();
	const anonymous = await visitor();
	let adminB: Awaited<ReturnType<typeof createMember>> | null = null;
	let member: Awaited<ReturnType<typeof createMember>> | null = null;
	const context = await browser.newContext({ baseURL: BASE_URL, storageState: undefined });
	try {
		adminB = await createMember(api, "admin");
		member = await createMember(api);
		const page = await context.newPage();
		await signIn(page, adminB.email, MEMBER_PASSWORD);
		await expect(page).toHaveURL(/\/inbox/);

		await page.goto("/admin");
		const menu = page.getByRole("complementary", { name: "Admin menu" });
		await expect(menu.getByRole("link", { name: "Accounts", exact: true })).toBeVisible();
		await expect(menu.getByRole("link", { name: "Modules", exact: true })).toHaveCount(0);
		await page.goto("/modules");
		await expect(page).toHaveURL(/\/admin$/);
		await expect(page.getByRole("heading", { level: 1, name: "Modules" })).toHaveCount(0);

		await page.goto(`/accounts/${member.id}/permissions`);
		await expect(page.getByRole("heading", { name: "Permissions" })).toBeVisible();
		await expect(page.getByRole("region", { name: "Modules", exact: true })).toHaveCount(0);

		const calls: [string, string, unknown?][] = [
			["GET", "/api/admin/modules"],
			["PUT", "/api/admin/modules", { moduleId: "templates", enabled: false }],
			["PUT", `/api/admin/accounts/${member.id}/modules`, { moduleId: "templates", allowed: false }],
		];
		for (const [method, path, data] of calls) {
			expect((await adminB.api.fetch(path, { method, data })).status(), `admin ${method} ${path}`).toBe(403);
			expect((await member.api.fetch(path, { method, data })).status(), `member ${method} ${path}`).toBe(403);
			expect((await anonymous.fetch(path, { method, data })).status(), `anonymous ${method} ${path}`).toBe(401);
		}
		expect((await adminB.api.get(`/api/admin/accounts/${member.id}/modules`)).status()).toBe(403);

		const memberPage = await (await browser.newContext({ baseURL: BASE_URL, storageState: undefined })).newPage();
		await signIn(memberPage, member.email, MEMBER_PASSWORD);
		await expect(memberPage).toHaveURL(/\/inbox/);
		await memberPage.goto("/modules");
		await expect(memberPage.getByRole("heading", { level: 1, name: "Modules" })).toHaveCount(0);
		await memberPage.context().close();

		const state = (await (await api.get("/api/admin/modules")).json()).modules;
		expect(
			state.every(
				(item: { enabled: boolean; restrictedUsers: unknown[] }) => item.enabled && !item.restrictedUsers.length,
			),
		).toBe(true);
	} finally {
		await restoreModules(api);
		await context.close();
		await adminB?.api.dispose();
		await member?.api.dispose();
		await anonymous.dispose();
		await api.dispose();
	}
});
