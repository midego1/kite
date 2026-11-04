import { expect, test, type APIRequestContext } from "@playwright/test";
import { ADMIN, BASE_URL } from "./support/constants";
import { signIn } from "./support/helpers";
import { restoreModules, setModuleState } from "./support/modules";
import { expectNotFoundPage, openAccountMenu } from "./support/module-flows";
import {
	MEMBER_PASSWORD,
	createMember,
	expectEveryModuleOn,
	moduleAccessCleanup,
	moduleSection,
	moduleSwitch,
	owner,
	visitor,
} from "./support/module-spec";

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

test("the Modules page lists the six modules with their dependencies, capabilities and notes", async ({ page }) => {
	await page.goto("/modules");
	await expect(page.getByRole("heading", { level: 1, name: "Modules" })).toBeVisible();
	await expect(page.locator("[data-module] h2")).toHaveText([
		"Calendar",
		"Booking",
		"Email templates",
		"Mail import",
		"Money Watch",
		"Drive",
	]);
	await expect(page.getByRole("heading", { level: 2, name: "Always on" })).toBeVisible();
	await expect(page.locator("[data-module]").getByRole("switch")).toHaveCount(6);
	await expect(page.getByText("up to 30 seconds to reach other open sessions")).toBeVisible();
	await expect(moduleSection(page, "Booking")).toContainText("Depends on Calendar");
	for (const name of ["Calendar", "Email templates", "Mail import", "Money Watch", "Drive"])
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
	const finance = moduleSection(page, "Money Watch");
	for (const item of [
		"mcp:finance-read",
		"finance.subscription.detected",
		"finance.subscription.renewal_due",
		"finance.open",
	])
		await expect(finance.getByText(item, { exact: true })).toBeVisible();
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
			["finance", true],
			["drive", true],
		]);
		expect((await (await api.get("/api/auth/me")).json()).modules).toEqual(["templates", "import", "finance", "drive"]);

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
			"finance",
			"drive",
		]);
		await page.goto("/booking");
		await expect(page.getByText("Page not found")).toHaveCount(0);

		// Booking off before Calendar stays off when Calendar returns.
		await setModuleState(api, { modules: { booking: false } });
		await setModuleState(api, { modules: { calendar: false } });
		await setModuleState(api, { modules: { calendar: true } });
		expect((await (await api.get("/api/auth/me")).json()).modules).toEqual([
			"calendar",
			"templates",
			"import",
			"finance",
			"drive",
		]);

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
		expect((await (await api.get("/api/auth/me")).json()).modules).toEqual(["calendar", "booking", "finance", "drive"]);
		for (const name of ["Email templates", "Mail import"]) {
			await moduleSwitch(page, name).click();
			await expect(moduleSwitch(page, name)).toHaveAttribute("aria-checked", "true");
		}
		expect((await (await api.get("/api/auth/me")).json()).modules).toEqual([
			"calendar",
			"booking",
			"templates",
			"import",
			"finance",
			"drive",
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

test("the module API refuses ids outside the six and bodies it cannot read, and core areas have no switch", async () => {
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
			["finance", true],
			["drive", true],
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
		await expect(section.getByRole("checkbox")).toHaveCount(6);
		await section.getByRole("checkbox", { name: "Allow Calendar" }).uncheck();
		await section.getByRole("button", { name: "Save module access" }).click();
		await expect(section.getByText("Module access updated")).toBeVisible();
		await page.reload();
		await expect(
			page.getByRole("region", { name: "Modules", exact: true }).getByRole("checkbox", { name: "Allow Calendar" }),
		).not.toBeChecked();

		expect((await (await target.api.get("/api/auth/me")).json()).modules).toEqual([
			"templates",
			"import",
			"finance",
			"drive",
		]);
		expect((await (await other.api.get("/api/auth/me")).json()).modules).toEqual([
			"calendar",
			"booking",
			"templates",
			"import",
			"finance",
			"drive",
		]);
		expect((await (await api.get("/api/auth/me")).json()).modules).toEqual([
			"calendar",
			"booking",
			"templates",
			"import",
			"finance",
			"drive",
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
			"finance",
			"drive",
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
			"finance",
			"drive",
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

// Fails this file when one of its tests left a module off or a user restricted.
test.afterAll(async () => {
	await expectEveryModuleOn();
});
