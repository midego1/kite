import { expect, test, type APIRequestContext } from "@playwright/test";
import { BASE_URL, STORAGE_STATE } from "./support/constants";
import { collectConsoleErrors, createSignedInAccount } from "./support/auto-read";
import { apiContext, uniqueToken } from "./support/helpers";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let api: APIRequestContext;

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

test("the owner turns anonymous usage statistics on and off in Admin General; nobody else can", async ({ browser }) => {
	await api.put("/api/admin/telemetry", { data: { enabled: false } });
	const context = await browser.newContext({ baseURL: BASE_URL, storageState: STORAGE_STATE });
	const page = await context.newPage();
	const errors = collectConsoleErrors(page);
	await page.goto("/general");
	const card = page.locator("[data-telemetry]");
	await expect(card.getByRole("heading", { name: "Anonymous usage statistics" })).toBeVisible();
	await expect(card.locator("[data-telemetry-status]")).toHaveText("Off");
	for (const field of ["install_id", "users_active_30d", "inbound_1d", "modules_enabled"])
		await expect(card.getByText(field, { exact: true })).toBeVisible();
	await expect(card).toContainText("KITE_TELEMETRY=0");
	const toggle = card.getByRole("switch", { name: "Share anonymous usage statistics with the Kite project" });
	await expect(toggle).toHaveAttribute("aria-checked", "false");
	const before = await auditCounts();

	await toggle.click();
	await expect(toggle).toHaveAttribute("aria-checked", "true");
	// The e2e server points KITE_TELEMETRY_URL at a `.invalid` host: nothing is sent.
	await expect(card.locator("[data-telemetry-status]")).toContainText("not a usable https address");
	const on = await (await api.get("/api/admin/telemetry")).json();
	expect(on).toMatchObject({ enabled: true, forcedOff: false, available: true, endpoint: null });
	expect(on.installId).toMatch(UUID);
	await expect(card).toContainText(on.installId);

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
	expect(await (await api.get("/api/admin/telemetry")).json()).toMatchObject({ enabled: false, installId: null });
	expect(await auditCounts()).toEqual({
		"telemetry.enabled": before["telemetry.enabled"] + 1,
		"telemetry.disabled": before["telemetry.disabled"] + 1,
	});
	expect(errors).toEqual([]);
	await context.close();
});
