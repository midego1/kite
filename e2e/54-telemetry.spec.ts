import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { BASE_URL, DOMAIN, E2E_TELEMETRY_URL, STORAGE_STATE } from "./support/constants";
import { collectConsoleErrors, createSignedInAccount } from "./support/auto-read";
import { sql } from "./support/drive";
import { apiContext, uniqueToken } from "./support/helpers";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SWITCH = "Share pseudonymous usage statistics with the Kite project";
const NOTICE = "Usage statistics notice";
const DAY_MS = 86_400_000;

let api: APIRequestContext;

async function telemetryStatus() {
	const response = await api.get("/api/admin/telemetry");
	expect(response.status()).toBe(200);
	return response.json();
}

/** The day a notice first seen now names: the UTC day after 14 full days. */
function expectedStartDay(): string {
	return new Date(Date.now() + 15 * DAY_MS).toISOString().slice(0, 10);
}

function dayLabel(day: string): string {
	return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(
		new Date(`${day}T00:00:00Z`),
	);
}

const noticeText = (day: string) =>
	`Kite will start sending usage statistics from 02:00 UTC on ${dayLabel(day)} unless you turn them off.`;

/** An install whose owner never chose, as after an upgrade: no row at all. */
function forgetChoice() {
	sql("DELETE FROM telemetry_state");
}

/** Waits until the page has asked for the telemetry status, so an absent notice is really absent. */
async function gotoAndWaitForStatus(page: Page, path: string) {
	const loaded = page.waitForResponse((response) => response.url().endsWith("/api/admin/telemetry"));
	await page.goto(path);
	await loaded;
}

/**
 * `/setup` renders the first-run flow only while no admin exists. Demotes the admins for the page load only (the
 * page's own requests are routed to fixtures), then restores exactly those accounts.
 */
async function withoutAdmins<T>(run: () => Promise<T>): Promise<T> {
	sql(
		"CREATE TABLE e2e_setup_admins AS SELECT id FROM users WHERE role = 'admin'; UPDATE users SET role = 'user' WHERE id IN (SELECT id FROM e2e_setup_admins);",
	);
	try {
		return await run();
	} finally {
		sql("UPDATE users SET role = 'admin' WHERE id IN (SELECT id FROM e2e_setup_admins); DROP TABLE e2e_setup_admins;");
	}
}

/** How many telemetry rows Admin → Activity lists per action. */
async function auditCounts(): Promise<Record<string, number>> {
	const response = await api.get("/api/audit-logs?limit=200");
	expect(response.status()).toBe(200);
	const { auditLogs } = (await response.json()) as { auditLogs: { action: string }[] };
	const counts: Record<string, number> = { "telemetry.enabled": 0, "telemetry.disabled": 0 };
	for (const { action } of auditLogs) if (action in counts) counts[action] += 1;
	return counts;
}

test.beforeAll(async () => {
	api = await apiContext(STORAGE_STATE);
});

test.afterAll(async () => {
	// Leave statistics off for the rest of the suite.
	await api.put("/api/admin/telemetry", { data: { enabled: false } });
	await api.dispose();
});

test("the first-run setup explains usage statistics and its switch is on until the owner turns it off", async ({
	browser,
}) => {
	const context = await browser.newContext({ baseURL: BASE_URL, storageState: { cookies: [], origins: [] } });
	const page = await context.newPage();
	const anonymous = await apiContext();
	let telemetry = { forcedOff: false, endpoint: "https://kite-telemetry.midego.net/v1/heartbeat" };
	const registrations: Record<string, unknown>[] = [];
	await page.route("**/api/setup/prepare", (route) => route.fulfill({ json: { checks: [], migrated: false } }));
	await page.route("**/api/setup/status", (route) =>
		route.fulfill({
			json: {
				hasAdminAccount: false,
				hasPrimaryDomain: true,
				primaryDomain: { hostname: DOMAIN, sendingRequested: true },
				telemetry,
			},
		}),
	);
	await page.route("**/api/setup/domain/mx", (route) => route.fulfill({ json: { hasExistingMx: false } }));
	// The registration never reaches the server: this database already has its owner.
	await page.route("**/api/auth/register", async (route) => {
		registrations.push(route.request().postDataJSON());
		await route.fulfill({ status: 400, json: { error: "Stopped by the e2e test" } });
	});
	try {
		const realStatus = await withoutAdmins(async () => {
			await page.goto("/setup");
			return (await anonymous.get("/api/setup/status")).json();
		});
		// Until the first account exists, the real setup status tells the page where reports would go.
		expect(realStatus.telemetry).toEqual({ forcedOff: false, endpoint: E2E_TELEMETRY_URL });

		await page.getByRole("button", { name: "Continue" }).click();
		const section = page.locator("[data-setup-telemetry]");
		await expect(section.getByRole("heading", { name: "Usage statistics" })).toBeVisible();
		for (const text of [
			"one small pseudonymous report a day, around 02:00 UTC",
			"Nothing is sent before you finish setup.",
			"pseudonymous, not anonymous",
			"CF-Worker",
			"kite-telemetry.midego.net",
			"run by the Kite project",
			"so the Kite project can see how many active installs there are and which versions, setups and modules they run",
			"kept for 90 days, then only totals without the install ID",
			"privacy@midego.net",
		])
			await expect(section).toContainText(text);
		await expect(section).not.toContainText(/Michiel|Gooijer|\(midego\)/);
		await expect(section.getByRole("link", { name: "Read the privacy page" })).toHaveAttribute(
			"href",
			/docs\/privacy\.md#usage-statistics$/,
		);
		await section.getByText("Exactly what is sent").click();
		for (const field of ["install_id", "users_active_30d", "mailboxes_active_1d", "modules_enabled"])
			await expect(section.getByText(field, { exact: true })).toBeVisible();

		const toggle = section.getByRole("switch", { name: "Send usage statistics" });
		await expect(toggle).toHaveAttribute("aria-checked", "true");
		await expect(section.locator("[data-setup-telemetry-hint]")).toHaveText(
			"On. The first report goes out at the first 02:00 UTC after setup.",
		);
		await toggle.click();
		await expect(toggle).toHaveAttribute("aria-checked", "false");
		await expect(section.locator("[data-setup-telemetry-hint]")).toHaveText(
			"Off. Nothing will be sent, and no install ID is made.",
		);
		await page.getByLabel("Username").fill("owner");
		await page.getByLabel("Password").fill("owner-password-123");
		await page.getByLabel("Recovery email").fill("owner@example.net");
		await page.getByRole("button", { name: "Create account" }).click();
		await expect.poll(() => registrations.length).toBe(1);
		expect(registrations[0].usageStatistics).toBe(false);

		// Under KITE_TELEMETRY=0 the switch is off and locked, and the request records nothing.
		telemetry = { forcedOff: true, endpoint: telemetry.endpoint };
		await withoutAdmins(() => page.goto("/setup"));
		await page.getByRole("button", { name: "Continue" }).click();
		const locked = page.locator("[data-setup-telemetry]").getByRole("switch", { name: "Send usage statistics" });
		await expect(locked).toHaveAttribute("aria-checked", "false");
		await expect(locked).toBeDisabled();
		await expect(page.locator("[data-setup-telemetry-hint]")).toHaveText(
			"Off: turned off by the KITE_TELEMETRY setting of this deployment.",
		);
		await page.getByLabel("Username").fill("owner");
		await page.getByLabel("Password").fill("owner-password-123");
		await page.getByLabel("Recovery email").fill("owner@example.net");
		await page.getByRole("button", { name: "Create account" }).click();
		await expect.poll(() => registrations.length).toBe(2);
		expect(registrations[1]).not.toHaveProperty("usageStatistics");
		// Nothing above reached the server's choice.
		expect(await telemetryStatus()).toMatchObject({ decision: "off", enabled: false, installId: null });
	} finally {
		await anonymous.dispose();
		await context.close();
	}
});

test("an install whose owner never chose is told first in Admin, and Turn off is final", async ({ page }) => {
	forgetChoice();
	const errors = collectConsoleErrors(page);
	const before = await auditCounts();
	expect(await telemetryStatus()).toMatchObject({ decision: null, enabled: false, notice: true, startDay: null });

	await page.goto("/admin");
	const notice = page.getByRole("region", { name: NOTICE });
	const startDay = expectedStartDay();
	await expect(notice).toContainText(noticeText(startDay));
	await expect(notice).toContainText("Nothing has been sent yet.");
	// One notice: the full one above the Admin page, not also the short one in the sidebar.
	await expect(notice).toHaveCount(1);
	await expect(page.getByTestId("kite-page-panel").getByRole("region", { name: NOTICE })).toHaveCount(1);
	await expect(page.getByTestId("kite-sidebar-panel").getByRole("region", { name: NOTICE })).toHaveCount(0);
	await expect(notice.getByRole("link", { name: "Exactly what is sent" })).toHaveAttribute("href", "/general");
	// Turn off and Keep on look the same.
	const buttonClass = (name: string) => notice.getByRole("button", { name }).getAttribute("class");
	expect(await buttonClass("Turn off")).toBe(await buttonClass("Keep on"));
	// The notice on screen fixed the start day; nothing is on yet and there is no install id.
	await expect.poll(async () => (await telemetryStatus()).startDay).toBe(startDay);
	expect(await telemetryStatus()).toMatchObject({
		decision: null,
		enabled: false,
		notice: true,
		startDay,
		installId: null,
	});

	await page.goto("/general");
	const card = page.locator("[data-telemetry]");
	await expect(card.locator("[data-telemetry-status]")).toHaveText(
		`On by default: sending starts at 02:00 UTC on ${dayLabel(startDay)} unless you turn it off`,
	);
	const toggle = card.getByRole("switch", { name: SWITCH });
	await expect(toggle).toHaveAttribute("aria-checked", "true");
	await notice.getByRole("button", { name: "Turn off" }).click();
	await expect(notice).toHaveCount(0);
	await expect(toggle).toHaveAttribute("aria-checked", "false");
	await expect(card.locator("[data-telemetry-status]")).toHaveText("Off");
	expect(await telemetryStatus()).toMatchObject({
		decision: "off",
		enabled: false,
		notice: false,
		startDay: null,
		installId: null,
	});
	expect((await auditCounts())["telemetry.disabled"]).toBe(before["telemetry.disabled"] + 1);

	// Shown once: never again, in Admin or in the sidebar.
	await gotoAndWaitForStatus(page, "/admin");
	await expect(page.getByRole("region", { name: NOTICE })).toHaveCount(0);
	await gotoAndWaitForStatus(page, "/inbox");
	await expect(page.getByRole("region", { name: NOTICE })).toHaveCount(0);
	expect(errors).toEqual([]);
});

test("Settings shows the short notice once, in the sidebar", async ({ page }) => {
	forgetChoice();
	await page.goto("/settings/appearance");
	const notice = page.getByRole("region", { name: NOTICE });
	await expect(notice).toContainText(noticeText(expectedStartDay()));
	await expect(notice).toHaveCount(1);
	await expect(page.getByTestId("kite-sidebar-panel").getByRole("region", { name: NOTICE })).toHaveCount(1);
	forgetChoice();
});

test("the sidebar notice: Hide keeps the start day, Keep on starts at once, the start day turns it on", async ({
	page,
}) => {
	forgetChoice();
	await page.goto("/inbox");
	const notice = page.getByRole("region", { name: NOTICE });
	const startDay = expectedStartDay();
	await expect(notice).toContainText(noticeText(startDay));
	await expect(notice).toContainText(
		"So the Kite project can see how many active installs there are and which versions, setups and modules they run. One pseudonymous daily report, rough counts only.",
	);
	await expect(notice).not.toContainText(/Michiel|Gooijer|\(midego\)/);
	await expect.poll(async () => (await telemetryStatus()).startDay).toBe(startDay);
	await notice.getByRole("button", { name: `Hide (statistics still start on ${dayLabel(startDay)} UTC)` }).click();
	await expect(notice).toHaveCount(0);
	expect(await telemetryStatus()).toMatchObject({ decision: null, enabled: false, notice: false, startDay });
	await gotoAndWaitForStatus(page, "/inbox");
	await expect(notice).toHaveCount(0);

	forgetChoice();
	await page.reload();
	await expect.poll(async () => (await telemetryStatus()).startDay).toBe(startDay);
	await notice.getByRole("button", { name: "Keep on" }).click();
	await expect(notice).toHaveCount(0);
	const kept = await telemetryStatus();
	expect(kept).toMatchObject({ decision: "on", enabled: true, notice: false, startDay: null });
	expect(kept.installId).toMatch(UUID);

	// Told long ago and never answered: once the start day has come, statistics are on with a fresh id. (Nothing is
	// posted: no spec runs the 02:00 cron.)
	forgetChoice();
	sql(
		"INSERT INTO telemetry_state (id, enabled, start_day, notice_dismissed, updated_at) VALUES ('default', 0, '2026-01-01', 1, 0)",
	);
	const started = await telemetryStatus();
	expect(started).toMatchObject({ decision: "on", enabled: true, notice: false, lastSentDay: null });
	expect(started.installId).toMatch(UUID);
	expect(started.installId).not.toBe(kept.installId);
	const off = await (await api.put("/api/admin/telemetry", { data: { enabled: false } })).json();
	expect(off).toMatchObject({ decision: "off", installId: null, erasure: { outcome: "not_needed", installId: null } });
});

test("the owner turns usage statistics on and off in Admin General; nobody else can", async ({ browser }) => {
	await api.put("/api/admin/telemetry", { data: { enabled: false } });
	const context = await browser.newContext({ baseURL: BASE_URL, storageState: STORAGE_STATE });
	const page = await context.newPage();
	const errors = collectConsoleErrors(page);
	await page.goto("/general");
	const card = page.locator("[data-telemetry]");
	await expect(card.getByRole("heading", { name: "Usage statistics" })).toBeVisible();
	await expect(card.locator("[data-telemetry-status]")).toHaveText("Off");
	for (const field of ["install_id", "users_active_30d", "mailboxes_active_1d", "modules_enabled"])
		await expect(card.getByText(field, { exact: true })).toBeVisible();
	await expect(card).toContainText("KITE_TELEMETRY=0");
	await expect(card).toContainText("CF-Worker");
	await expect(card).toContainText("pseudonymous");
	await expect(card).toContainText(
		"so the Kite project can see how many active installs there are and which versions, setups and modules they run",
	);
	await expect(card).not.toContainText(/Michiel|Gooijer|\(midego\)/);
	const toggle = card.getByRole("switch", { name: SWITCH });
	await expect(toggle).toHaveAttribute("aria-checked", "false");
	const before = await auditCounts();

	await toggle.click();
	await expect(toggle).toHaveAttribute("aria-checked", "true");
	// No spec runs the 02:00 cron, and the e2e collector address answers nothing: nothing is sent.
	await expect(card.locator("[data-telemetry-status]")).toHaveText("On, nothing sent yet");
	await expect(card).toContainText(`Sent to ${E2E_TELEMETRY_URL}`);
	const on = await (await api.get("/api/admin/telemetry")).json();
	expect(on).toMatchObject({ enabled: true, forcedOff: false, available: true, endpoint: E2E_TELEMETRY_URL });
	expect(on.installId).toMatch(UUID);
	await expect(card.locator("[data-telemetry-install-id]")).toHaveText(on.installId);
	await expect(card.getByRole("button", { name: "Copy ID" })).toBeVisible();

	const account = await createSignedInAccount(api, `tel${uniqueToken("")}`, "admin");
	try {
		expect((await account.api.get("/api/admin/telemetry")).status()).toBe(403);
		expect((await account.api.put("/api/admin/telemetry", { data: { enabled: false } })).status()).toBe(403);
	} finally {
		await account.api.dispose();
	}
	expect((await api.put("/api/admin/telemetry", { data: { enabled: "yes" } })).status()).toBe(400);
	const crossSite = await api.put("/api/admin/telemetry", {
		data: { enabled: false },
		headers: { Origin: "https://attacker.example.test" },
	});
	expect(crossSite.status()).toBe(403);
	expect((await (await api.get("/api/admin/telemetry")).json()).enabled).toBe(true);

	await toggle.click();
	await expect(toggle).toHaveAttribute("aria-checked", "false");
	await expect(card.locator("[data-telemetry-status]")).toHaveText("Off");
	await expect(card).not.toContainText(on.installId);
	// Nothing was ever sent (no heartbeat ran), so there is nothing for the collector to erase.
	await expect(card.locator("[data-telemetry-erasure]")).toHaveCount(0);
	expect(await (await api.get("/api/admin/telemetry")).json()).toMatchObject({ enabled: false, installId: null });
	expect(await auditCounts()).toEqual({
		"telemetry.enabled": before["telemetry.enabled"] + 1,
		"telemetry.disabled": before["telemetry.disabled"] + 1,
	});
	const offAgain = await (await api.put("/api/admin/telemetry", { data: { enabled: false } })).json();
	expect(offAgain.erasure).toEqual({ outcome: "not_needed", installId: null });
	expect(errors).toEqual([]);
	await context.close();
});
