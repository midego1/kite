import { expect, test, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";
import { ADMIN, BASE_URL, DOMAIN, STORAGE_STATE } from "./support/constants";
import { readAdminAgent, useFakeProvider as pointAssistantAtFake } from "./support/agent";
import {
	CALENDAR_TOOLS,
	askAssistant,
	chatRequests,
	firstMailboxId,
	openAssistantPanel,
	openPageCommands,
	sendChat,
	systemPrompt,
	toolNames,
} from "./support/chat";
import { startFakeModel } from "./support/fake-model";
import type { FakeModel } from "./support/fake-model-types";
import { apiContext, postInbound, signIn, uniqueToken, waitForMessage } from "./support/helpers";
import { createSignedInAccount, okJson, selectMailbox } from "./support/auto-read";
import { futureAt, inviteAttachment } from "./support/invites";
import { readSuggestions, waitForFinishedJob } from "./support/triage";
import { callOutcome, createMcpKey, mcpCall, mcpToolNames } from "./support/mcp";
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

const PALETTE_PLACEHOLDER = "Type a command or search actions...";

/** Opens the palette with the keyboard and returns the search box. */
async function openPalette(page: Page) {
	const search = page.getByPlaceholder(PALETTE_PLACEHOLDER);
	await expect(async () => {
		if (!(await search.isVisible())) await page.keyboard.press("Control+k");
		await expect(search).toBeVisible({ timeout: 1000 });
	}).toPass();
	return search;
}

async function runPaletteCommand(page: Page, query: string) {
	const search = await openPalette(page);
	await search.fill(query);
	await expect(page.getByRole("button", { name: new RegExp(query, "i") }).first()).toBeVisible();
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
	await expect(page.getByText("c", { exact: true })).toBeVisible();
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
			for (const query of ["calendar", "booking"]) {
				await search.fill(query);
				await expect(page.getByText(`No matching commands found for “${query}”`), `${path} ${query}`).toBeVisible();
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
		await expect(page.getByText("No matching commands found")).toBeVisible();
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
		await expect(page.getByText("No matching commands found")).toBeVisible();
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

const CALENDAR_PROMPT = "Use calendar tools only for the user's personal calendar";

/** Starts a fake model, points the assistant at it and returns what each chat test needs, with its cleanup. */
async function fakeAssistant(api: APIRequestContext) {
	const fake = await startFakeModel();
	let restore: (() => Promise<void>) | null = null;
	try {
		restore = await pointAssistantAtFake(api, fake);
	} catch (error) {
		await fake.close();
		throw error;
	}
	return {
		fake,
		cleanup: async () => {
			await restore?.();
			await fake.close();
		},
	};
}

async function lastChatRequest(fake: FakeModel) {
	const requests = chatRequests(fake);
	expect(requests.length).toBeGreaterThan(0);
	return requests[requests.length - 1];
}

test.describe("assistant chat reads the module registry", () => {
	test("calendar tools, the calendar prompt and calendar pages follow the Calendar module, and core tools never leave", async () => {
		const api = await owner();
		const { fake, cleanup } = await fakeAssistant(api);
		try {
			const mailboxId = await firstMailboxId(api);
			const zone = "Europe/Amsterdam";
			const ask = async (text: string) => {
				fake.clearRequests();
				await sendChat(api, mailboxId, text);
				return lastChatRequest(fake);
			};

			const on = await ask("What is on today?");
			for (const name of [...CALENDAR_TOOLS, "list_emails", "search_emails", "open_page"])
				expect(toolNames(on), name).toContain(name);
			const everything = openPageCommands(on) ?? [];
			for (const id of [
				"calendar.open",
				"calendar.go_to_date",
				"booking.open",
				"booking.open_event_type",
				"import.open",
				"mail.export",
				"nav-inbox",
				"nav-settings",
			])
				expect(everything, id).toContain(id);
			for (const id of ["compose", "calendar.new_event", "booking.copy_link"]) expect(everything, id).not.toContain(id);
			const promptOn = systemPrompt(on);
			expect(promptOn).toContain("You are a helpful email assistant");
			expect(promptOn).toContain(CALENDAR_PROMPT);
			expect(promptOn).not.toMatch(/\{timeZone\}|\{today\}/);
			expect(promptOn).toContain(`Read relative dates in ${zone}`);
			expect(promptOn).toMatch(/today is \d{4}-\d{2}-\d{2}\./);

			await setModuleState(api, { modules: { calendar: false } });
			const off = await ask("What is on today?");
			for (const name of CALENDAR_TOOLS) expect(toolNames(off), name).not.toContain(name);
			for (const name of ["list_emails", "search_emails", "open_page"]) expect(toolNames(off), name).toContain(name);
			const enumOff = openPageCommands(off) ?? [];
			expect(enumOff.filter((id) => id.startsWith("calendar.") || id.startsWith("booking."))).toEqual([]);
			expect(enumOff).toContain("import.open");
			expect(enumOff).toContain("mail.export");
			const promptOff = systemPrompt(off);
			expect(promptOff).not.toContain(CALENDAR_PROMPT);
			expect(promptOff.toLowerCase()).not.toContain("calendar");
			expect(promptOff).toContain("You are a helpful email assistant");

			await setModuleState(api, { modules: { calendar: true } });
			const back = await ask("What is on today?");
			for (const name of CALENDAR_TOOLS) expect(toolNames(back), name).toContain(name);
			expect(systemPrompt(back)).toContain(CALENDAR_PROMPT);

			await setModuleState(api, { modules: { booking: false } });
			const bookingOff = openPageCommands(await ask("Where can I book?")) ?? [];
			expect(bookingOff).toContain("calendar.open");
			expect(bookingOff).toContain("calendar.go_to_date");
			expect(bookingOff.filter((id) => id.startsWith("booking."))).toEqual([]);
			await setModuleState(api, { modules: { booking: true } });

			await setModuleState(api, { modules: { import: false } });
			const importOff = openPageCommands(await ask("Where do I import?")) ?? [];
			expect(importOff).not.toContain("import.open");
			expect(importOff).toContain("mail.export");
			expect(importOff).toContain("calendar.open");
		} finally {
			await restoreModules(api);
			await cleanup();
			await api.dispose();
		}
	});

	test("a user restricted from Calendar gets no calendar tools, prompt or pages while the owner keeps them", async () => {
		const api = await owner();
		const { fake, cleanup } = await fakeAssistant(api);
		let restricted: string[] = [];
		try {
			const member = await createMember(api);
			restricted = [member.id];
			await setModuleState(api, { access: [{ userId: member.id, moduleId: "calendar", allowed: false }] });
			const ownerMailbox = await firstMailboxId(api);
			const memberMailbox = await firstMailboxId(member.api);

			fake.clearRequests();
			await sendChat(member.api, memberMailbox, "What is on today?");
			const theirs = await lastChatRequest(fake);
			for (const name of CALENDAR_TOOLS) expect(toolNames(theirs), name).not.toContain(name);
			expect(toolNames(theirs)).toEqual(expect.arrayContaining(["list_emails", "open_page"]));
			const theirPages = openPageCommands(theirs) ?? [];
			expect(theirPages.filter((id) => id.startsWith("calendar.") || id.startsWith("booking."))).toEqual([]);
			expect(theirPages).toContain("mail.export");
			expect(systemPrompt(theirs)).not.toContain(CALENDAR_PROMPT);

			fake.clearRequests();
			await sendChat(api, ownerMailbox, "What is on today?");
			const mine = await lastChatRequest(fake);
			for (const name of CALENDAR_TOOLS) expect(toolNames(mine), name).toContain(name);
			expect(openPageCommands(mine)).toContain("calendar.open");
			expect(systemPrompt(mine)).toContain(CALENDAR_PROMPT);
			await moduleAccessCleanup([member]);
		} finally {
			await restoreModules(api, restricted);
			await cleanup();
			await api.dispose();
		}
	});

	test("open_page shows a clickable same-origin link, navigates nothing by itself and the link opens the page", async ({
		page,
	}) => {
		const api = await owner();
		const { fake, cleanup } = await fakeAssistant(api);
		try {
			await page.addInitScript(() => localStorage.setItem("kite-assistant-layout", "floating"));
			const panel = await openAssistantPanel(page);
			const links = panel.locator("a[data-agent-tool-link]");

			fake.scriptChat(
				{ toolCalls: [{ name: "open_page", arguments: { command: "calendar.open" } }] },
				{ content: "Here is your calendar." },
			);
			const before = page.url();
			await askAssistant(page, "Open my calendar");
			await expect(panel.getByText("Here is your calendar.")).toBeVisible();
			await expect(links).toHaveCount(1);
			await expect(links.first()).toHaveAttribute("href", "/calendar");
			await expect(links.first()).toHaveText("Open Calendar");
			expect(page.url()).toBe(before);
			await page.screenshot({ path: test.info().outputPath("open-page-link.png") });
			await links.first().click();
			await expect(page).toHaveURL(/\/calendar$/);

			fake.scriptChat(
				{
					toolCalls: [
						{ name: "open_page", arguments: { command: "calendar.go_to_date", params: { date: "2026-11-03" } } },
					],
				},
				{ content: "Opened that day." },
			);
			const second = await openAssistantPanel(page);
			await askAssistant(page, "Show 3 November");
			await expect(second.getByText("Opened that day.")).toBeVisible();
			const dateLink = second.locator("a[data-agent-tool-link]").last();
			await expect(dateLink).toHaveAttribute("href", "/calendar?date=2026-11-03");
			await dateLink.click();
			await expect(page).toHaveURL(/\/calendar\?date=2026-11-03/);
			for (const href of await second
				.locator("a")
				.evaluateAll((anchors) => anchors.map((a) => a.getAttribute("href")))) {
				if (href) expect(href.startsWith("/") && !href.startsWith("//"), href).toBe(true);
			}
		} finally {
			await restoreModules(api);
			await cleanup();
			await api.dispose();
		}
	});

	test("open_page refuses unknown and disabled ids, invalid params and arbitrary URLs, and no link appears", async ({
		page,
	}) => {
		const api = await owner();
		const { fake, cleanup } = await fakeAssistant(api);
		try {
			const mailboxId = await firstMailboxId(api);
			const refused = [
				{ command: "https://evil.example/x" },
				{ command: "//evil.example" },
				{ command: "no.such.command" },
				{ command: "calendar.go_to_date", params: { date: "not-a-date" } },
				{ command: "calendar.go_to_date", params: { date: "2026-11-03", href: "//evil.example" } },
				{ command: "calendar.open", params: { next: "https://evil.example" } },
			];
			const callAll = (calls: object[]) =>
				fake.scriptChat(
					{ toolCalls: calls.map((arguments_) => ({ name: "open_page", arguments: arguments_ })) },
					{ content: "I could not open that." },
				);

			callAll(refused);
			const events = await sendChat(api, mailboxId, "Open these pages");
			const results = events.filter((event) => event.type === "tool" && event.state !== "running");
			expect(results).toHaveLength(refused.length);
			for (const result of results) {
				expect(result.state).toBe("failed");
				expect(JSON.stringify(result.result)).not.toContain("evil.example/x");
			}
			expect(events.some((event) => event.type === "text" && event.text === "I could not open that.")).toBe(true);

			await setModuleState(api, { modules: { calendar: false } });
			callAll([{ command: "calendar.open" }, { command: "booking.open" }]);
			const disabled = await sendChat(api, mailboxId, "Open the calendar");
			const disabledResults = disabled.filter((event) => event.type === "tool" && event.state !== "running");
			expect(disabledResults).toHaveLength(2);
			for (const result of disabledResults) expect(result.state).toBe("failed");
			await setModuleState(api, { modules: { calendar: true } });

			await page.addInitScript(() => localStorage.setItem("kite-assistant-layout", "floating"));
			const panel = await openAssistantPanel(page);
			callAll(refused);
			await askAssistant(page, "Open these pages");
			await expect(panel.getByText("I could not open that.")).toBeVisible();
			await expect(panel.locator("a[data-agent-tool-link]")).toHaveCount(0);
			for (const href of await panel
				.locator("a")
				.evaluateAll((anchors) => anchors.map((a) => a.getAttribute("href")))) {
				if (href) expect(href.startsWith("/") && !href.startsWith("//"), href).toBe(true);
			}
		} finally {
			await restoreModules(api);
			await cleanup();
			await api.dispose();
		}
	});

	test("a scripted create_event result carries the event ref and the chat links it to the event", async ({ page }) => {
		const api = await owner();
		const { fake, cleanup } = await fakeAssistant(api);
		let eventId: string | null = null;
		try {
			await page.addInitScript(() => localStorage.setItem("kite-assistant-layout", "floating"));
			const panel = await openAssistantPanel(page);
			const title = `Ref check ${Date.now()}`;
			fake.scriptChat(
				{
					toolCalls: [
						{
							name: "create_event",
							arguments: { title, startsAt: "2026-11-03T10:00:00Z", endsAt: "2026-11-03T11:00:00Z", timeZone: "UTC" },
						},
					],
				},
				{ content: "The event is on your calendar." },
			);
			await askAssistant(page, "Add a meeting on 3 November");
			await expect(panel.getByText("The event is on your calendar.")).toBeVisible();
			const link = panel.locator("a[data-agent-tool-link]").first();
			await expect(link).toHaveText(title);
			const href = (await link.getAttribute("href")) ?? "";
			expect(href).toMatch(/^\/calendar\?date=\d{4}-\d{2}-\d{2}&event=evt_[\w-]+$/);
			eventId = new URL(href, "http://x").searchParams.get("event");
			await page.screenshot({ path: test.info().outputPath("create-event-ref.png") });

			const secondRequest = chatRequests(fake).at(-1);
			const toolMessages = (
				(secondRequest?.body as { messages: { role: string; content: unknown }[] }).messages ?? []
			).filter((message) => message.role === "tool");
			expect(toolMessages).toHaveLength(1);
			expect(JSON.parse(String(toolMessages[0].content))).toMatchObject({
				status: "created",
				ref: { kind: "calendar:event", id: eventId },
			});
			for (const href of await panel
				.locator("a")
				.evaluateAll((anchors) => anchors.map((a) => a.getAttribute("href")))) {
				if (href) expect(href.startsWith("/") && !href.startsWith("//"), href).toBe(true);
			}

			await setModuleState(api, { modules: { calendar: false } });
			await page.reload();
			await page.getByRole("button", { name: /^(Open|Close) email assistant$/ }).waitFor();
		} finally {
			await restoreModules(api);
			if (eventId) await api.delete(`/api/calendar/events/${eventId}`);
			await cleanup();
			await api.dispose();
		}
	});
});

test("automatic reading requests carry no tools, UI commands or open_page, with Calendar on and off", async () => {
	const api = await owner();
	const { fake, cleanup } = await fakeAssistant(api);
	let memberApi: APIRequestContext | null = null;
	try {
		const member = await createMember(api);
		memberApi = member.api;
		const { mailboxes } = (await (await member.api.get("/api/mailboxes")).json()) as {
			mailboxes: { id: string; localPart: string }[];
		};
		const mailboxId = mailboxes.find((item) => item.localPart === member.email.split("@")[0])!.id;
		const saved = await member.api.put("/api/agent/settings", { data: { mailboxId, autonomy: "suggest" } });
		expect(saved.ok(), await saved.text()).toBe(true);
		const commandIds = (openPageCommands(await lastChatRequestAfterChat(api, fake)) ?? []).filter((id) =>
			id.includes("."),
		);
		expect(commandIds.length).toBeGreaterThan(3);

		for (const calendar of [true, false]) {
			await setModuleState(api, { modules: { calendar } });
			const token = uniqueToken(calendar ? "autoon" : "autooff");
			await postInbound(member.api, {
				from: "Customer <customer@outside.test>",
				to: member.email,
				subject: token,
				text: `Can you confirm ${token}? [[scenario:question]]`,
			});
			const message = await waitForMessage(member.api, token, { status: "received" });
			const job = await waitForFinishedJob(member.api, mailboxId, message.id, "triage");
			expect(job.status).toBe("completed");
			const mine = fake.requests().filter((request) => JSON.stringify(request.body).includes(token));
			expect(new Set(mine.map((request) => request.kind)).has("triage")).toBe(true);
			for (const request of mine) {
				expect(["triage", "repair", "draft"], String(request.kind)).toContain(request.kind);
				expect(request.tools, String(request.kind)).toEqual([]);
				expect(request.body).not.toHaveProperty("tools");
				const prompt = systemPrompt(request);
				expect(prompt).not.toContain("open_page");
				for (const id of commandIds) expect(prompt, id).not.toContain(id);
			}
		}
	} finally {
		await restoreModules(api);
		await memberApi?.dispose();
		await cleanup();
		await api.dispose();
	}
});

async function lastChatRequestAfterChat(api: APIRequestContext, fake: FakeModel) {
	fake.clearRequests();
	await sendChat(api, await firstMailboxId(api), "Hello");
	return lastChatRequest(fake);
}

test("assistant controls answer the same with Calendar on and off and gain no module fields", async () => {
	const api = await owner();
	const { fake, cleanup } = await fakeAssistant(api);
	try {
		const mailboxId = await firstMailboxId(api);
		const seen: { admin: string[]; mailbox: string[]; capabilities: string[] }[] = [];
		for (const calendar of [true, false]) {
			await setModuleState(api, { modules: { calendar } });
			const admin = await readAdminAgent(api);
			const mailbox = (await (await api.get(`/api/agent/settings?mailboxId=${mailboxId}`)).json()) as {
				settings: { capabilities: Record<string, unknown> } & Record<string, unknown>;
			};
			seen.push({
				admin: Object.keys(admin).sort(),
				mailbox: Object.keys(mailbox.settings).sort(),
				capabilities: Object.keys(mailbox.settings.capabilities).sort(),
			});
			expect(admin.dailySpendCapMicros).toBeGreaterThan(0);

			for (const autonomy of ["act", "auto"]) {
				const refused = await api.put("/api/agent/settings", { data: { mailboxId, autonomy } });
				expect(refused.status(), autonomy).toBe(400);
			}
			for (const autonomy of ["suggest", "off"]) {
				const saved = await api.put("/api/agent/settings", { data: { mailboxId, autonomy } });
				expect(saved.status(), autonomy).toBe(200);
			}

			const answered = await sendChat(api, mailboxId, "Hello");
			expect(answered.some((event) => event.type === "text" || event.type === "done")).toBe(true);
			const off = await api.put("/api/admin/agent", { data: { enabled: false } });
			expect(off.ok(), await off.text()).toBe(true);
			const refusal = await api.post("/api/agent/chat", { data: { mailboxId, text: "Hello" } });
			expect(refusal.status()).toBe(400);
			const on = await api.put("/api/admin/agent", { data: { enabled: true } });
			expect(on.ok(), await on.text()).toBe(true);
		}
		expect(seen[1]).toEqual(seen[0]);
		expect(fake.requests().length).toBeGreaterThan(0);
	} finally {
		await restoreModules(api);
		await cleanup();
		await api.dispose();
	}
});

test("a calendar invitation suggestion is hidden while Calendar is off, no new one is made, and it returns when Calendar is on", async ({
	browser,
}) => {
	const api = await owner();
	const contexts: BrowserContext[] = [];
	const { cleanup } = await fakeAssistant(api);
	const account = await createSignedInAccount(api, `invoff${uniqueToken("")}`);
	try {
		await okJson(
			await account.api.put("/api/agent/settings", { data: { mailboxId: account.mailboxId, autonomy: "suggest" } }),
		);
		const address = `${(await (await account.api.get("/api/auth/me")).json()).user.email}`;
		const deliver = async (label: string) => {
			const subject = uniqueToken(label);
			await postInbound(account.api, {
				from: "Alice <alice@partner.test>",
				to: address,
				subject,
				text: "Please join.",
				attachments: [
					inviteAttachment({ uid: `${uniqueToken("uid")}@partner.test`, start: futureAt(20, 10), summary: "Planning" }),
				],
			});
			const message = await waitForMessage(account.api, subject, { status: "received" });
			const job = await waitForFinishedJob(account.api, account.mailboxId, message.id, "triage");
			return { message, job, subject };
		};
		const invitesOf = async (messageId: string) =>
			(await readSuggestions(account.api, { mailboxId: account.mailboxId, messageId })).suggestions.filter(
				(item) => item.kind === "calendar_invite",
			);
		const rowKinds = async (subject: string) => {
			const { messages } = await okJson<{
				messages: { subject: string; agentSuggestions?: { kind: string }[] }[];
			}>(await account.api.get(`/api/messages?mailboxId=${account.mailboxId}&q=${encodeURIComponent(subject)}`));
			return (messages.find((item) => item.subject === subject)?.agentSuggestions ?? []).map((item) => item.kind);
		};

		const first = await deliver("invon");
		expect(first.job.status).toBe("completed");
		expect(first.job.reason).toBeNull();
		const [invite] = await invitesOf(first.message.id);
		expect(invite).toBeDefined();
		expect(await rowKinds(first.subject)).toContain("calendar_invite");

		await setModuleState(api, { modules: { calendar: false } });
		expect(await invitesOf(first.message.id)).toEqual([]);
		expect(await rowKinds(first.subject)).not.toContain("calendar_invite");
		const refused = await account.api.post(`/api/agent/suggestions/${invite.id}/accept`, {
			data: { option: "accept" },
		});
		expect(refused.status()).toBe(409);
		expect(await refused.json()).toMatchObject({ code: "module_disabled" });

		const second = await deliver("invoff");
		expect(second.job.status).toBe("completed");
		expect(second.job.reason).toBe("module_disabled:calendar");
		expect(await invitesOf(second.message.id)).toEqual([]);

		const activity = await okJson<{ skippedJobs: { reason: string | null }[] }>(
			await account.api.get(`/api/agent/actions?mailboxId=${account.mailboxId}`),
		);
		expect(activity.skippedJobs.map((job) => job.reason)).toContain("module_disabled:calendar");

		const context = await browser.newContext({ baseURL: BASE_URL, storageState: await account.api.storageState() });
		contexts.push(context);
		const page = await context.newPage();
		await selectMailbox(page, account.mailboxId);
		await page.goto("/kite-activity");
		const skipped = page.locator(`[data-activity-skipped="${second.job.id}"]`);
		await expect(skipped).toContainText("Calendar is turned off");
		await expect(page.locator("[data-agent-activity]")).not.toContainText("module_disabled");
		await page.goto("/for-you");
		await expect(page.getByRole("heading", { name: "For you" })).toBeVisible();
		await expect(page.getByText("Invitations", { exact: true })).toHaveCount(0);

		await setModuleState(api, { modules: { calendar: true } });
		expect((await invitesOf(first.message.id)).map((item) => item.id)).toEqual([invite.id]);
		expect(await rowKinds(first.subject)).toContain("calendar_invite");
		expect(await invitesOf(second.message.id)).toEqual([]);
	} finally {
		await Promise.all(contexts.map((context) => context.close()));
		await restoreModules(api);
		await account.api.put("/api/agent/settings", { data: { mailboxId: account.mailboxId, autonomy: "off" } });
		await account.api.dispose();
		await cleanup();
		await api.dispose();
	}
});

const CALENDAR_MCP_TOOLS = [...CALENDAR_TOOLS].sort();
const CALENDAR_READ_TOOLS = ["find_free_time", "get_calendars", "get_event", "get_schedule", "search_events"];
const CALENDAR_SCOPES = ["mcp:calendar-read", "mcp:calendar-write"];

async function mailboxIdOf(api: APIRequestContext): Promise<string> {
	return firstMailboxId(api);
}

/** Deletes the keys a test created, whichever way they were made. */
async function deleteKeys(api: APIRequestContext, ids: { mcp?: string[]; api?: string[] }) {
	for (const id of ids.mcp ?? []) await api.delete(`/api/agent/mcp-keys?id=${encodeURIComponent(id)}`);
	for (const id of ids.api ?? []) await api.delete(`/api/api-keys?id=${encodeURIComponent(id)}`);
}

test("MCP lists the calendar tools only while Calendar is on for the key's user, and an old key gets them back", async () => {
	const api = await owner();
	const rpcApi = await visitor();
	const created: string[] = [];
	let member: Awaited<ReturnType<typeof createMember>> | null = null;
	try {
		const mailboxId = await mailboxIdOf(api);
		const full = await createMcpKey(api, "E2E module tools", ["mcp:read", ...CALENDAR_SCOPES], [mailboxId]);
		created.push(full.id);

		const before = await mcpToolNames(rpcApi, full.key);
		expect(before).toEqual(expect.arrayContaining([...CALENDAR_MCP_TOOLS, "list_mailboxes", "list_emails"]));

		await setModuleState(api, { modules: { calendar: false } });
		const init = await mcpCall(rpcApi, full.key, "initialize", {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "kite-e2e", version: "1.0.0" },
		});
		expect(init.error).toBeUndefined();
		const off = await mcpToolNames(rpcApi, full.key);
		for (const tool of CALENDAR_MCP_TOOLS) expect(off, tool).not.toContain(tool);
		expect(off).toEqual(expect.arrayContaining(["list_mailboxes", "list_emails", "search_emails"]));

		const listed = (await (await api.get("/api/agent/mcp-keys")).json()) as {
			keys: { id: string; scopes: string }[];
		};
		expect(JSON.parse(listed.keys.find((key) => key.id === full.id)!.scopes)).toEqual(["mcp:read", ...CALENDAR_SCOPES]);

		const title = uniqueToken("mcp-off");
		const unknown = await mcpCall(rpcApi, full.key, "tools/call", { name: "no_such_tool", arguments: {} });
		expect(unknown.error ?? unknown.result?.isError).toBeTruthy();
		const schedule = await mcpCall(rpcApi, full.key, "tools/call", {
			name: "get_schedule",
			arguments: { start: "2030-01-01T00:00:00Z", end: "2030-01-08T00:00:00Z" },
		});
		const create = await mcpCall(rpcApi, full.key, "tools/call", {
			name: "create_event",
			arguments: { title, startsAt: "2030-01-02T10:00:00Z", endsAt: "2030-01-02T11:00:00Z" },
		});
		for (const [name, response] of [
			["get_schedule", schedule],
			["create_event", create],
		] as const) {
			expect(callOutcome(response, name), name).toBe(callOutcome(unknown, "no_such_tool"));
		}

		await setModuleState(api, { modules: { calendar: true } });
		expect(await mcpToolNames(rpcApi, full.key)).toEqual(before);
		const made = await mcpCall(rpcApi, full.key, "tools/call", {
			name: "create_event",
			arguments: { title, startsAt: "2030-01-02T10:00:00Z", endsAt: "2030-01-02T11:00:00Z" },
		});
		expect(made.result?.isError, JSON.stringify(made)).toBeFalsy();
		const events = (await (
			await api.get("/api/calendar/events?start=2030-01-01T00:00:00Z&end=2030-01-08T00:00:00Z")
		).json()) as { events: { id: string; title: string }[] };
		expect(events.events.filter((event) => event.title === title)).toHaveLength(1);
		const eventId = events.events.find((event) => event.title === title)!.id;
		await api.delete(`/api/calendar/events/${eventId}`);

		member = await createMember(api);
		const memberKey = await createMcpKey(
			member.api,
			"E2E member tools",
			["mcp:read", ...CALENDAR_SCOPES],
			[await mailboxIdOf(member.api)],
		);
		created.push(memberKey.id);
		expect(await mcpToolNames(rpcApi, memberKey.key)).toEqual(expect.arrayContaining(CALENDAR_MCP_TOOLS));
		await setModuleState(api, { access: [{ userId: member.id, moduleId: "calendar", allowed: false }] });
		const restricted = await mcpToolNames(rpcApi, memberKey.key);
		for (const tool of CALENDAR_MCP_TOOLS) expect(restricted, tool).not.toContain(tool);
		expect(restricted).toContain("list_mailboxes");
		expect(await mcpToolNames(rpcApi, full.key)).toEqual(expect.arrayContaining(CALENDAR_MCP_TOOLS));
	} finally {
		await restoreModules(api, member ? [member.id] : []);
		await deleteKeys(api, { mcp: created });
		if (member) await deleteKeys(member.api, { mcp: created });
		await member?.api.dispose();
		await rpcApi.dispose();
		await api.dispose();
	}
});

test("calendar MCP scopes need no mailbox and the read scope lists only the read tools", async () => {
	const api = await owner();
	const rpcApi = await visitor();
	const created: string[] = [];
	try {
		const read = await createMcpKey(api, "E2E calendar read", ["mcp:calendar-read"], []);
		const write = await createMcpKey(api, "E2E calendar write", ["mcp:calendar-write"], []);
		created.push(read.id, write.id);
		expect(await mcpToolNames(rpcApi, read.key)).toEqual(CALENDAR_READ_TOOLS);
		expect(await mcpToolNames(rpcApi, write.key)).toEqual(CALENDAR_MCP_TOOLS);

		const mailOnly = await api.post("/api/agent/mcp-keys", {
			data: { name: "E2E no mailbox", mailboxIds: [], scopes: ["mcp:read"] },
		});
		expect(mailOnly.status()).toBe(400);
		expect(await mailOnly.json()).toEqual({ error: "Choose a mailbox for mail permissions" });
	} finally {
		await deleteKeys(api, { mcp: created });
		await rpcApi.dispose();
		await api.dispose();
	}
});

test("creating a key with a disabled module's scope answers 400 MODULE_DISABLED, and core scopes still work", async () => {
	const api = await owner();
	let member: Awaited<ReturnType<typeof createMember>> | null = null;
	const created = { mcp: [] as string[], api: [] as string[] };
	const keyCount = async () => {
		const mcp = (await (await api.get("/api/agent/mcp-keys")).json()) as { keys: unknown[] };
		const standard = (await (await api.get("/api/api-keys")).json()) as { apiKeys: unknown[] };
		return mcp.keys.length + standard.apiKeys.length;
	};
	try {
		const mailboxId = await mailboxIdOf(api);
		const refuse = async (caller: APIRequestContext, path: string, data: Record<string, unknown>) => {
			const response = await caller.post(path, { data });
			expect(response.status(), await response.text()).toBe(400);
			expect(await response.json()).toMatchObject({ code: "MODULE_DISABLED", moduleId: "calendar" });
		};

		await setModuleState(api, { modules: { calendar: false } });
		const before = await keyCount();
		await refuse(api, "/api/agent/mcp-keys", { name: "off", mailboxIds: [], scopes: ["mcp:calendar-read"] });
		await refuse(api, "/api/agent/mcp-keys", {
			name: "off",
			mailboxIds: [mailboxId],
			scopes: ["mcp:read", "mcp:calendar-write"],
		});
		await refuse(api, "/api/api-keys", { name: "off", mailboxIds: [], scopes: ["calendar:read"] });
		await refuse(api, "/api/api-keys", { name: "off", mailboxIds: [mailboxId], scopes: ["read", "calendar:write"] });
		expect(await keyCount()).toBe(before);

		const core = await api.post("/api/api-keys", {
			data: { name: "E2E core while off", mailboxIds: [mailboxId], scopes: ["read"] },
		});
		expect(core.status(), await core.text()).toBe(200);
		created.api.push(((await core.json()) as { id: string }).id);
		const unknown = await api.post("/api/api-keys", {
			data: { name: "x", mailboxIds: [mailboxId], scopes: ["foo:bar"] },
		});
		expect(unknown.status()).toBe(400);
		expect(await unknown.json()).not.toHaveProperty("code");

		await setModuleState(api, { modules: { calendar: true } });
		const mcp = await api.post("/api/agent/mcp-keys", {
			data: { name: "E2E calendar on", mailboxIds: [], scopes: ["mcp:calendar-read"] },
		});
		expect(mcp.status(), await mcp.text()).toBe(200);
		created.mcp.push(((await mcp.json()) as { id: string }).id);
		const standard = await api.post("/api/api-keys", {
			data: { name: "E2E calendar rest on", mailboxIds: [], scopes: ["calendar:read"] },
		});
		expect(standard.status(), await standard.text()).toBe(200);
		created.api.push(((await standard.json()) as { id: string }).id);

		member = await createMember(api);
		await setModuleState(api, { access: [{ userId: member.id, moduleId: "calendar", allowed: false }] });
		await refuse(member.api, "/api/agent/mcp-keys", { name: "off", mailboxIds: [], scopes: ["mcp:calendar-read"] });
		await refuse(member.api, "/api/api-keys", { name: "off", mailboxIds: [], scopes: ["calendar:write"] });
	} finally {
		await restoreModules(api, member ? [member.id] : []);
		await deleteKeys(api, created);
		await member?.api.dispose();
		await api.dispose();
	}
});

test("the REST calendar answers 404 to a calendar key while Calendar is off and works again when it is on", async () => {
	const api = await owner();
	const keyed = await visitor();
	const created: string[] = [];
	try {
		const key = await api.post("/api/api-keys", {
			data: { name: "E2E calendar rest", mailboxIds: [], scopes: ["calendar:read", "calendar:write"] },
		});
		expect(key.status(), await key.text()).toBe(200);
		const { id, key: secret } = (await key.json()) as { id: string; key: string };
		created.push(id);
		const headers = { Authorization: `Bearer ${secret}` };
		const title = uniqueToken("rest-key");
		const body = { title, startsAt: "2030-02-02T10:00:00Z", endsAt: "2030-02-02T11:00:00Z" };

		expect((await keyed.get("/api/calendar/events", { headers })).status()).toBe(200);

		await setModuleState(api, { modules: { calendar: false } });
		const list = await keyed.get("/api/calendar/events", { headers });
		expect(list.status()).toBe(404);
		expect(await list.json()).toEqual({ error: "Not found" });
		const post = await keyed.post("/api/calendar/events", { headers, data: body });
		expect(post.status()).toBe(404);
		const keys = (await (await api.get("/api/api-keys")).json()) as { apiKeys: { id: string; scopes: string }[] };
		expect(JSON.parse(keys.apiKeys.find((item) => item.id === id)!.scopes)).toEqual([
			"calendar:read",
			"calendar:write",
		]);

		await setModuleState(api, { modules: { calendar: true } });
		expect((await keyed.get("/api/calendar/events", { headers })).status()).toBe(200);
		const made = await keyed.post("/api/calendar/events", { headers, data: body });
		expect(made.status(), await made.text()).toBeLessThan(300);
		const eventId = ((await made.json()) as { event?: { id: string }; id?: string }).event?.id;
		if (eventId) await api.delete(`/api/calendar/events/${eventId}`);
	} finally {
		await restoreModules(api);
		await deleteKeys(api, { api: created });
		await keyed.dispose();
		await api.dispose();
	}
});

test("the key forms list calendar scopes only while Calendar is on, and existing keys keep theirs", async ({
	page,
}) => {
	const api = await owner();
	const created = { mcp: [] as string[], api: [] as string[] };
	const optionNames = async () => {
		await page.goto("/settings/api-keys");
		await page.getByRole("button", { name: "New API key" }).click();
		const dialog = page.getByRole("dialog");
		const standard = await dialog.getByRole("group", { name: "Permissions" }).locator("strong").allTextContents();
		await dialog.getByRole("checkbox", { name: /Allow MCP access/ }).check();
		const mcp = await dialog.getByRole("group", { name: "Permissions" }).locator("strong").allTextContents();
		return { standard, mcp };
	};
	try {
		const mailboxId = await mailboxIdOf(api);
		const made = await createMcpKey(api, "E2E form keeps scopes", ["mcp:calendar-read"], []);
		created.mcp.push(made.id);
		const rest = await api.post("/api/api-keys", {
			data: { name: "E2E form rest key", mailboxIds: [mailboxId], scopes: ["read", "calendar:read"] },
		});
		created.api.push(((await rest.json()) as { id: string }).id);

		const on = await optionNames();
		expect(on.standard).toEqual(["Read mail", "Send mail", "Read calendar", "Manage calendar"]);
		expect(on.mcp).toEqual([
			"Read mail",
			"Manage drafts",
			"Organize mail",
			"Request send review",
			"Read calendar",
			"Manage calendar",
		]);

		await setModuleState(api, { modules: { calendar: false } });
		const off = await optionNames();
		expect(off.standard).toEqual(["Read mail", "Send mail"]);
		expect(off.mcp).toEqual(["Read mail", "Manage drafts", "Organize mail", "Request send review"]);
		await page.keyboard.press("Escape");
		const row = page.getByText("E2E form keeps scopes").locator("xpath=ancestor::span[contains(@class,'flex-1')][1]");
		await expect(row.getByText("mcp:calendar-read", { exact: true })).toBeVisible();
		await expect(
			page
				.getByText("E2E form rest key")
				.locator("xpath=ancestor::span[contains(@class,'flex-1')][1]")
				.getByText("calendar:read", { exact: true }),
		).toBeVisible();

		await setModuleState(api, { modules: { calendar: true } });
		expect((await optionNames()).standard).toContain("Read calendar");
	} finally {
		await restoreModules(api);
		await deleteKeys(api, created);
		await api.dispose();
	}
});

async function deleteWebhooks(api: APIRequestContext, ids: string[]) {
	for (const id of ids) await api.delete(`/api/webhooks/${id}`);
}

const CALENDAR_EVENT_LABELS = ["Calendar event created", "Calendar event updated", "Calendar event deleted"];

test("the webhook picker lists calendar and booking events only while their modules are on", async ({ page }) => {
	const api = await owner();
	const eventLabels = async () => {
		await page.goto("/webhooks");
		await page.getByRole("button", { name: "Add endpoint" }).click();
		const dialog = page.getByRole("dialog");
		await expect(dialog.getByText("Inbound message", { exact: true })).toBeVisible();
		return dialog.locator("label span.font-medium").allTextContents();
	};
	try {
		const on = await eventLabels();
		expect(on).toEqual([
			"Inbound message",
			"Outbound message",
			"Delivery failure",
			...CALENDAR_EVENT_LABELS,
			"Appointment booked",
		]);

		await setModuleState(api, { modules: { booking: false } });
		expect(await eventLabels()).toEqual([
			"Inbound message",
			"Outbound message",
			"Delivery failure",
			...CALENDAR_EVENT_LABELS,
		]);

		await setModuleState(api, { modules: { calendar: false } });
		expect(await eventLabels()).toEqual(["Inbound message", "Outbound message", "Delivery failure"]);
		const listed = (await (await api.get("/api/webhooks")).json()) as {
			eventCatalog: { value: string; available: boolean }[];
		};
		expect(listed.eventCatalog.filter((event) => event.available).map((event) => event.value)).toEqual([
			"message.inbound",
			"message.outbound",
			"message.failed",
		]);
	} finally {
		await restoreModules(api);
		await api.dispose();
	}
});

test("a webhook for a disabled module's event is refused with MODULE_DISABLED, and existing subscriptions keep it", async () => {
	const api = await owner();
	const created: string[] = [];
	const url = "https://hooks.e2e-modules.invalid/receiver";
	try {
		await setModuleState(api, { modules: { calendar: false } });
		const refused = await api.post("/api/webhooks", { data: { url, events: ["calendar.event.created"] } });
		expect(refused.status(), await refused.text()).toBe(400);
		expect(await refused.json()).toMatchObject({ code: "MODULE_DISABLED", moduleId: "calendar" });
		const mixed = await api.post("/api/webhooks", {
			data: { url, events: ["message.inbound", "calendar.event.deleted"] },
		});
		expect(mixed.status()).toBe(400);
		const core = await api.post("/api/webhooks", { data: { url, events: ["message.inbound"] } });
		expect(core.status(), await core.text()).toBeLessThan(300);

		await setModuleState(api, { modules: { calendar: true } });
		const made = await api.post("/api/webhooks", {
			data: { url, events: ["message.inbound", "calendar.event.created"] },
		});
		expect(made.status(), await made.text()).toBeLessThan(300);
		created.push(((await made.json()) as { id: string }).id);
		const coreId = (
			(await (await api.get("/api/webhooks")).json()) as { webhooks: { id: string; url: string; events: string[] }[] }
		).webhooks.find((hook) => hook.events.length === 1 && hook.events[0] === "message.inbound" && hook.url === url)?.id;
		if (coreId) created.push(coreId);

		await setModuleState(api, { modules: { calendar: false } });
		const edited = await api.patch(`/api/webhooks/${created[0]}`, { data: { description: "kept while off" } });
		expect(edited.status(), await edited.text()).toBeLessThan(300);
		const same = await api.patch(`/api/webhooks/${created[0]}`, {
			data: { events: ["message.inbound", "calendar.event.created"] },
		});
		expect(same.status(), await same.text()).toBeLessThan(300);
		const added = await api.patch(`/api/webhooks/${created[0]}`, {
			data: { events: ["message.inbound", "calendar.event.created", "calendar.event.updated"] },
		});
		expect(added.status()).toBe(400);
		expect(await added.json()).toMatchObject({ code: "MODULE_DISABLED" });
		const after = (await (await api.get("/api/webhooks")).json()) as { webhooks: { id: string; events: string[] }[] };
		expect(after.webhooks.find((hook) => hook.id === created[0])?.events).toEqual([
			"message.inbound",
			"calendar.event.created",
		]);
	} finally {
		await restoreModules(api);
		await deleteWebhooks(api, created);
		await api.dispose();
	}
});

type DeliveryRow = { id: string; eventType: string; status: string; error: string | null; payload: string };

async function deliveriesOf(api: APIRequestContext, webhookId: string): Promise<DeliveryRow[]> {
	const response = await api.get(`/api/webhooks/${webhookId}/deliveries?limit=100`);
	return ((await response.json()) as { deliveries: DeliveryRow[] }).deliveries;
}

test("calendar writes and public bookings emit one webhook delivery each with refs, nothing while off, and a dropped retry says why", async () => {
	const api = await owner();
	const visitorApi = await visitor();
	const cleanup = { webhooks: [] as string[], events: [] as string[], bookings: [] as string[] };
	try {
		const made = await api.post("/api/webhooks", {
			data: {
				url: "https://hooks.e2e-modules.invalid/deliveries",
				events: [
					"calendar.event.created",
					"calendar.event.updated",
					"calendar.event.deleted",
					"booking.appointment.created",
				],
				maxAttempts: 2,
			},
		});
		expect(made.status(), await made.text()).toBeLessThan(300);
		const hookId = ((await made.json()) as { id: string }).id;
		cleanup.webhooks.push(hookId);

		const title = uniqueToken("hook-event");
		const created = await api.post("/api/calendar/events", {
			data: { title, startsAt: "2031-05-05T10:00:00Z", endsAt: "2031-05-05T11:00:00Z" },
		});
		const eventId = ((await created.json()) as { event: { id: string } }).event.id;
		cleanup.events.push(eventId);
		await expect
			.poll(
				async () =>
					(await deliveriesOf(api, hookId)).filter((row) => row.eventType === "calendar.event.created").length,
			)
			.toBe(1);
		const [row] = (await deliveriesOf(api, hookId)).filter((item) => item.eventType === "calendar.event.created");
		expect(JSON.parse(row!.payload)).toMatchObject({
			type: "calendar.event.created",
			data: { ref: { kind: "calendar:event", id: eventId }, event: { id: eventId, title } },
		});

		const username = (await ownerBooking(api)).username;
		const slug = uniqueToken("hook-book").toLowerCase();
		const type = await api.post("/api/booking", {
			data: {
				name: "Hook booking",
				slug,
				durationMinutes: 30,
				weekdays: [0, 1, 2, 3, 4, 5, 6],
				timeRanges: [{ startTime: "09:00", endTime: "17:00" }],
				timeZone: "UTC",
				enabled: true,
			},
		});
		expect(type.status(), await type.text()).toBe(200);
		cleanup.bookings.push(((await type.json()) as { event: { id: string } }).event.id);
		const page = `/api/public/booking/${slug}?username=${username}`;
		const { slots } = (await (await visitorApi.get(page)).json()) as { slots: { startsAt: string }[] };
		const booker = { name: "Hook Booker", email: "hook.booker@example.org", startsAt: slots[0]!.startsAt };
		const booked = await visitorApi.post(page, { data: booker });
		expect(booked.status(), await booked.text()).toBe(200);
		expect((await visitorApi.post(page, { data: booker })).status()).toBe(409);
		await expect
			.poll(
				async () =>
					(await deliveriesOf(api, hookId)).filter((row) => row.eventType === "booking.appointment.created").length,
			)
			.toBe(1);
		const appointment = (await deliveriesOf(api, hookId)).find(
			(item) => item.eventType === "booking.appointment.created",
		)!;
		expect(JSON.parse(appointment.payload).data).toMatchObject({
			ref: { kind: "booking:appointment" },
			appointment: { bookerEmail: "hook.booker@example.org", timeZone: "UTC" },
		});

		await setModuleState(api, { modules: { calendar: false } });
		const before = (await deliveriesOf(api, hookId)).length;
		expect(
			(
				await api.post("/api/calendar/events", {
					data: { title, startsAt: "2031-05-06T10:00:00Z", endsAt: "2031-05-06T11:00:00Z" },
				})
			).status(),
		).toBe(404);
		const retry = await api.post(`/api/webhooks/${hookId}/deliveries/${row!.id}/retry`);
		expect(retry.status(), await retry.text()).toBe(200);
		await expect
			.poll(async () => (await deliveriesOf(api, hookId)).find((item) => item.id === row!.id)?.error ?? "")
			.toContain("module_disabled");
		expect((await deliveriesOf(api, hookId)).length).toBe(before);
	} finally {
		await restoreModules(api);
		for (const id of cleanup.events) await api.delete(`/api/calendar/events/${id}`);
		for (const id of cleanup.bookings) await api.delete(`/api/booking/${id}`);
		await deleteWebhooks(api, cleanup.webhooks);
		await visitorApi.dispose();
		await api.dispose();
	}
});

test("JMAP answers the same session and methods with every module on and every module off", async () => {
	const api = await owner();
	const jmap = await visitor();
	const created: string[] = [];
	try {
		const mailboxId = await mailboxIdOf(api);
		const key = await api.post("/api/api-keys", {
			data: { name: "E2E jmap modules", mailboxIds: [mailboxId], scopes: ["jmap"] },
		});
		expect(key.status(), await key.text()).toBe(200);
		const { id, key: secret } = (await key.json()) as { id: string; key: string };
		created.push(id);
		const headers = { Authorization: `Bearer ${secret}` };
		const session = async () =>
			(await (await jmap.get("/jmap/session", { headers })).json()) as Record<string, unknown>;
		const call = async (methodCalls: unknown[]) =>
			(await (
				await jmap.post("/jmap/api", {
					headers,
					data: { using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"], methodCalls },
				})
			).json()) as {
				methodResponses: [string, Record<string, unknown>, string][];
			};
		const withModulesOn = await session();
		expect(Object.keys(withModulesOn.capabilities as object).sort()).toEqual([
			"urn:ietf:params:jmap:core",
			"urn:ietf:params:jmap:mail",
			"urn:ietf:params:jmap:submission",
		]);
		const accountId = Object.keys(withModulesOn.accounts as object)[0];
		const mailboxes = await call([["Mailbox/get", { accountId }, "m"]]);
		expect(mailboxes.methodResponses[0][0]).toBe("Mailbox/get");

		await setModuleState(api, { modules: { calendar: false, templates: false, import: false } });
		expect(await session()).toEqual(withModulesOn);
		const off = await call([
			["Mailbox/get", { accountId }, "m"],
			["Email/query", { accountId, limit: 5 }, "q"],
			["Calendar/get", { accountId }, "x"],
		]);
		expect(off.methodResponses.map(([name]) => name)).toEqual(["Mailbox/get", "Email/query", "error"]);
		expect(off.methodResponses[0][1]).toEqual(mailboxes.methodResponses[0][1]);
		expect(off.methodResponses[2][1]).toEqual({ type: "unknownMethod" });
	} finally {
		await restoreModules(api);
		await deleteKeys(api, { api: created });
		await jmap.dispose();
		await api.dispose();
	}
});

type SearchSection = {
	id: string;
	label: string;
	items: { ref: { kind: string; id: string }; label: string; sublabel: string; href: string }[];
};

async function searchSections(api: APIRequestContext, query: string, extra = ""): Promise<SearchSection[]> {
	const response = await api.get(`/api/search?q=${encodeURIComponent(query)}${extra}`);
	expect(response.status(), await response.text()).toBe(200);
	return ((await response.json()) as { sections: SearchSection[] }).sections;
}

async function createEvent(api: APIRequestContext, title: string, extra: Record<string, unknown> = {}) {
	const created = await api.post("/api/calendar/events", {
		data: { title, startsAt: "2031-05-05T10:00:00Z", endsAt: "2031-05-05T11:00:00Z", ...extra },
	});
	expect(created.status(), await created.text()).toBeLessThan(300);
	return ((await created.json()) as { event: { id: string } }).event.id;
}

test("GET /api/search returns the viewer's own events with refs and links, and nothing for anyone else", async () => {
	const api = await owner();
	const member = await createMember(api);
	const events: { api: APIRequestContext; id: string }[] = [];
	try {
		const ownerWord = uniqueToken("ownerword");
		const memberWord = uniqueToken("memberword");
		const ownerEvent = await createEvent(api, `Review ${ownerWord}`, { location: "Room 4" });
		events.push({ api, id: ownerEvent });
		events.push({ api: member.api, id: await createEvent(member.api, `Review ${memberWord}`) });

		const [section, ...others] = await searchSections(api, ownerWord, "&limit=5");
		expect(others).toEqual([]);
		expect(section).toMatchObject({ id: "events", label: "Events" });
		expect(section!.items).toHaveLength(1);
		const [item] = section!.items;
		expect(item).toMatchObject({ ref: { kind: "calendar:event", id: ownerEvent }, label: `Review ${ownerWord}` });
		expect(item!.sublabel).toContain("Room 4");
		expect(item!.href).toBe(`/calendar?date=2031-05-05&event=${ownerEvent}`);

		expect(await searchSections(api, memberWord)).toEqual([]);
		expect(await searchSections(member.api, ownerWord)).toEqual([]);
		expect((await searchSections(member.api, memberWord))[0]!.items).toHaveLength(1);
		expect(await searchSections(api, "from:someone has:attachment")).toEqual([]);
		expect(await searchSections(api, "")).toEqual([]);
	} finally {
		for (const { api: client, id } of events) await client.delete(`/api/calendar/events/${id}`);
		await member.api.dispose();
		await api.dispose();
	}
});

test("event search follows a rename and a delete, and covers description, location and guests", async () => {
	const api = await owner();
	let id = "";
	try {
		const alpha = uniqueToken("alphaword");
		const beta = uniqueToken("betaword");
		const extra = uniqueToken("extraword");
		const guest = uniqueToken("guestword");
		const fields = { description: `notes ${extra}`, location: `${extra}hall`, attendees: [`${guest}@example.org`] };
		id = await createEvent(api, alpha, fields);
		expect((await searchSections(api, alpha))[0]?.items.map((entry) => entry.ref.id)).toEqual([id]);
		expect((await searchSections(api, extra))[0]?.items.map((entry) => entry.ref.id)).toEqual([id]);
		expect((await searchSections(api, `${extra}hall`))[0]?.items.map((entry) => entry.ref.id)).toEqual([id]);

		expect((await searchSections(api, guest))[0]?.items.map((entry) => entry.ref.id)).toEqual([id]);

		const renamed = await api.patch(`/api/calendar/events/${id}`, {
			data: { title: beta, startsAt: "2031-05-05T10:00:00Z", endsAt: "2031-05-05T11:00:00Z", ...fields },
		});
		expect(renamed.status(), await renamed.text()).toBeLessThan(300);
		expect(await searchSections(api, alpha)).toEqual([]);
		expect((await searchSections(api, beta))[0]?.items.map((entry) => entry.ref.id)).toEqual([id]);

		expect((await api.delete(`/api/calendar/events/${id}`)).status()).toBeLessThan(300);
		id = "";
		expect(await searchSections(api, alpha)).toEqual([]);
		expect(await searchSections(api, beta)).toEqual([]);
	} finally {
		if (id) await api.delete(`/api/calendar/events/${id}`);
		await api.dispose();
	}
});

test("search needs a session: signed-out and key-only requests answer 401", async () => {
	const api = await owner();
	const anonymous = await visitor();
	const keyOnly = await visitor();
	const created: string[] = [];
	try {
		expect((await anonymous.get("/api/search?q=anything")).status()).toBe(401);
		const key = await api.post("/api/api-keys", {
			data: { name: "E2E search key", mailboxIds: [], scopes: ["calendar:read"] },
		});
		expect(key.status(), await key.text()).toBe(200);
		const { id, key: secret } = (await key.json()) as { id: string; key: string };
		created.push(id);
		const response = await keyOnly.get("/api/search?q=anything", { headers: { Authorization: `Bearer ${secret}` } });
		expect(response.status()).toBe(401);
	} finally {
		await deleteKeys(api, { api: created });
		await keyOnly.dispose();
		await anonymous.dispose();
		await api.dispose();
	}
});

test("with Calendar off or the user restricted, search has no Events section and it returns when Calendar is back", async () => {
	const api = await owner();
	const member = await createMember(api);
	let id = "";
	try {
		const word = uniqueToken("offword");
		id = await createEvent(api, word);
		expect((await searchSections(api, word))[0]?.id).toBe("events");

		await setModuleState(api, { modules: { calendar: false } });
		expect(await searchSections(api, word)).toEqual([]);
		await setModuleState(api, { modules: { calendar: true } });
		expect((await searchSections(api, word))[0]?.id).toBe("events");

		const memberWord = uniqueToken("memberoff");
		const memberEvent = await createEvent(member.api, memberWord);
		await setModuleState(api, { access: [{ userId: member.id, moduleId: "calendar", allowed: false }] });
		expect(await searchSections(member.api, memberWord)).toEqual([]);
		await setModuleState(api, { access: [{ userId: member.id, moduleId: "calendar", allowed: true }] });
		expect((await searchSections(member.api, memberWord))[0]?.id).toBe("events");
		await member.api.delete(`/api/calendar/events/${memberEvent}`);
	} finally {
		await restoreModules(api, [member.id]);
		if (id) await api.delete(`/api/calendar/events/${id}`);
		await member.api.dispose();
		await api.dispose();
	}
});

test("the mail search dropdown lists Events, opens the chosen event and leaves Enter to the mail search", async ({
	page,
}) => {
	const api = await owner();
	let id = "";
	try {
		const word = uniqueToken("dropword");
		id = await createEvent(api, `Planning ${word}`, { location: "Harbour" });
		await page.goto("/inbox");
		const field = page.getByRole("textbox", { name: /Search mail/ });
		await field.fill(word);
		const dropdown = page.getByTestId("search-dropdown");
		const events = dropdown.locator('[data-search-section="events"]');
		await expect(events.getByText("Events", { exact: true })).toBeVisible();
		await expect(events.getByRole("option", { name: new RegExp(`Planning ${word}`) })).toBeVisible();

		// Enter with nothing highlighted keeps the mail search: no navigation, the list is filtered.
		await field.press("Enter");
		await expect(page).toHaveURL(/\/inbox/);
		await expect(page.getByRole("main").getByText("No messages match these filters")).toBeVisible();

		await events.getByRole("option", { name: new RegExp(`Planning ${word}`) }).click();
		await expect(page).toHaveURL(/\/calendar/);
		const editor = page.getByRole("dialog", { name: "Edit event" });
		await expect(editor.getByRole("textbox", { name: "Event name" })).toHaveValue(`Planning ${word}`);
		await expect(page.getByRole("heading", { level: 1 }).or(page.getByText("May 2031")).first()).toBeVisible();
	} finally {
		if (id) await api.delete(`/api/calendar/events/${id}`);
		await api.dispose();
	}
});

test("the dropdown is keyboard driven and gone with Calendar off", async ({ page }) => {
	const api = await owner();
	let id = "";
	try {
		const word = uniqueToken("keyword");
		id = await createEvent(api, `Keys ${word}`);
		await page.goto("/inbox");
		const field = page.getByRole("textbox", { name: /Search mail/ });
		await field.fill(word);
		await expect(page.getByRole("option", { name: new RegExp(`Keys ${word}`) })).toBeVisible();
		await field.press("Escape");
		await expect(page.getByTestId("search-dropdown")).toHaveCount(0);
		await field.fill(`${word} `);
		await field.fill(word);
		await field.press("ArrowDown");
		await expect(page.getByRole("option", { name: new RegExp(`Keys ${word}`) })).toHaveAttribute(
			"aria-selected",
			"true",
		);
		await field.press("Enter");
		await expect(page).toHaveURL(/\/calendar/);
		await expect(
			page.getByRole("dialog", { name: "Edit event" }).getByRole("textbox", { name: "Event name" }),
		).toHaveValue(`Keys ${word}`);

		await setModuleState(api, { modules: { calendar: false } });
		await page.goto("/inbox");
		await page.getByRole("textbox", { name: /Search mail/ }).fill(word);
		await expect(page.getByText("No messages match these filters")).toBeVisible();
		await expect(page.getByTestId("search-dropdown")).toHaveCount(0);
	} finally {
		await restoreModules(api);
		if (id) await api.delete(`/api/calendar/events/${id}`);
		await api.dispose();
	}
});

test("an account made while Booking is off gets its booking username when Booking is back, and account creation never fails for it", async () => {
	const api = await owner();
	let member: Awaited<ReturnType<typeof createMember>> | null = null;
	try {
		await setModuleState(api, { modules: { booking: false } });
		member = await createMember(api);
		await setModuleState(api, { modules: { booking: true } });
		const lazy = await member.api.get("/api/booking");
		expect(lazy.status(), await lazy.text()).toBe(200);
		expect(((await lazy.json()) as { username: string }).username).toMatch(/\S+/);

		const second = await createMember(api);
		const assigned = await second.api.get("/api/booking");
		expect(((await assigned.json()) as { username: string }).username).toMatch(/\S+/);
		await second.api.dispose();
	} finally {
		await restoreModules(api);
		await member?.api.dispose();
		await api.dispose();
	}
});

test("changing the time zone works with Calendar off and still answers the new zone", async () => {
	const api = await owner();
	try {
		const me = await (await api.get("/api/auth/me")).json();
		const previous = (me.user.timeZone as string | null) ?? null;
		await setModuleState(api, { modules: { calendar: false } });
		const changed = await api.patch("/api/settings/time-zone", { data: { timeZone: "Europe/Paris" } });
		expect(changed.status(), await changed.text()).toBe(200);
		expect(await changed.json()).toEqual({ timeZone: "Europe/Paris" });
		await api.patch("/api/settings/time-zone", { data: { timeZone: previous } });
	} finally {
		await restoreModules(api);
		await api.dispose();
	}
});

async function createTemplate(api: APIRequestContext, title: string, text: string): Promise<string> {
	const { mailboxes } = (await (await api.get("/api/mailboxes")).json()) as {
		mailboxes: { id: string; senderAddresses: string[] }[];
	};
	const created = await api.post("/api/templates", {
		data: { mailboxId: mailboxes[0].id, from: mailboxes[0].senderAddresses[0], title, text, html: `<p>${text}</p>` },
	});
	expect(created.status(), await created.text()).toBe(201);
	return ((await created.json()) as { template: { id: string } }).template.id;
}

/** What the page asks for while the composer's send menu is opened, collected until the returned function is read. */
function watchTemplateTraffic(page: Page): () => string[] {
	const seen: string[] = [];
	page.on("request", (request) => {
		const path = new URL(request.url()).pathname;
		if (path.includes("/api/templates") || path.includes("components/modules/templates/")) seen.push(path);
	});
	return () => seen;
}

async function openSendMenu(page: Page) {
	await page.goto("/inbox");
	await page.getByRole("button", { name: "Compose" }).click();
	await page.getByRole("button", { name: "Schedule send options" }).click();
	const menu = page.getByRole("menu");
	await expect(menu.getByText("Schedule", { exact: true })).toBeVisible();
	return menu;
}

async function expectScheduleOnlyMenu(page: Page, seen: () => string[]) {
	const menu = await openSendMenu(page);
	await expect(menu.getByRole("menuitem", { name: "Template" })).toHaveCount(0);
	await expect(menu.getByText("New template")).toHaveCount(0);
	await expect(menu.locator("> *").first()).toHaveText("Schedule");
	await expect(menu.getByRole("menuitem", { name: "Tomorrow morning" })).toBeVisible();
	await page.waitForTimeout(500);
	expect(seen()).toEqual([]);
	await page.keyboard.press("Escape");
}

async function templateStatusRows(api: APIRequestContext): Promise<{ id: string }[]> {
	const response = await api.get("/api/messages?status=template");
	expect(response.status(), await response.text()).toBe(200);
	return ((await response.json()) as { messages: { id: string }[] }).messages;
}

test("with Templates off the send menu has only schedule options and no template request or code, and the template still applies when it is back", async ({
	page,
}) => {
	const api = await owner();
	const word = uniqueToken("tplword");
	let templateId = "";
	try {
		templateId = await createTemplate(api, `Template subject ${word}`, `Template body ${word}`);
		expect((await templateStatusRows(api)).map((row) => row.id)).toContain(templateId);
		for (const status of ["received", "sent", "draft", "spam", "trash", "archived"]) {
			const listed = (await (await api.get(`/api/messages?status=${status}`)).json()) as { messages: { id: string }[] };
			expect(
				listed.messages.map((row) => row.id),
				status,
			).not.toContain(templateId);
		}
		const everything = (await (await api.get(`/api/messages?q=${word}`)).json()) as { messages: unknown[] };
		expect(everything.messages).toEqual([]);

		await setModuleState(api, { modules: { templates: false } });
		const seen = watchTemplateTraffic(page);
		await expectScheduleOnlyMenu(page, seen);

		expect((await api.get("/api/templates")).status()).toBe(404);
		expect((await api.post("/api/templates", { data: { title: "x", text: "y" } })).status()).toBe(404);
		const deleted = await api.delete(`/api/templates/${templateId}`);
		expect(deleted.status()).toBe(404);
		expect(await deleted.json()).toEqual({ error: "Not found" });
		expect(await templateStatusRows(api)).toEqual([]);
		const offLists = (await (await api.get("/api/messages")).json()) as { messages: { id: string }[] };
		expect(offLists.messages.map((row) => row.id)).not.toContain(templateId);

		await setModuleState(api, { modules: { templates: true } });
		expect((await templateStatusRows(api)).map((row) => row.id)).toContain(templateId);
		const menu = await openSendMenu(page);
		await expect(menu.getByRole("menuitem", { name: "Template" })).toBeVisible();
		expect(seen()).toContain("/api/templates");
		// The submenu is opened and picked by keyboard: a teleporting pointer leaves Radix's grace area and closes it.
		await menu.getByRole("menuitem", { name: "Template" }).focus();
		await page.keyboard.press("ArrowRight");
		await expect(page.getByRole("menuitem", { name: "New template" })).toBeVisible();
		await page.getByRole("menuitem", { name: `Template subject ${word}` }).focus();
		await page.keyboard.press("Enter");
		await expect(page.getByLabel("Subject")).toHaveValue(`Template subject ${word}`);
		await expect(page.getByRole("textbox", { name: "Message body" })).toContainText(`Template body ${word}`);
	} finally {
		await restoreModules(api);
		if (templateId) await api.delete(`/api/templates/${templateId}`);
		await api.dispose();
	}
});

test("a user restricted from Templates loses the slot and the API while the owner keeps both", async ({
	browser,
	page,
}) => {
	const api = await owner();
	const member = await createMember(api);
	const context = await browser.newContext({ baseURL: BASE_URL, storageState: undefined });
	let templateId = "";
	try {
		const word = uniqueToken("tplmember");
		templateId = await createTemplate(api, `Member template ${word}`, `Body ${word}`);
		await setModuleState(api, { access: [{ userId: member.id, moduleId: "templates", allowed: false }] });

		const memberPage = await context.newPage();
		await signIn(memberPage, member.email, MEMBER_PASSWORD);
		await expect(memberPage).toHaveURL(/\/inbox/);
		const seen = watchTemplateTraffic(memberPage);
		await expectScheduleOnlyMenu(memberPage, seen);
		expect((await member.api.get("/api/templates")).status()).toBe(404);
		expect(await templateStatusRows(member.api)).toEqual([]);

		expect((await api.get("/api/templates")).status()).toBe(200);
		expect((await templateStatusRows(api)).map((row) => row.id)).toContain(templateId);
		const menu = await openSendMenu(page);
		await expect(menu.getByRole("menuitem", { name: "Template" })).toBeVisible();
	} finally {
		await restoreModules(api, [member.id]);
		if (templateId) await api.delete(`/api/templates/${templateId}`);
		await context.close();
		await member.api.dispose();
		await api.dispose();
	}
});
