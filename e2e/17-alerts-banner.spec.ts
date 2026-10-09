import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { DOMAIN, E2E_PERSIST_DIR, STORAGE_STATE } from "./support/constants";
import { apiContext, signIn, uniqueToken } from "./support/helpers";

const ACTIVE_API = "/api/admin/alerts/active";
const DISMISSED_KEY = "kite-dismissed-alerts";
const STUCK_NAME = "Outbound messages stuck in the queue";
const USER_PASSWORD = "banner-user-password-123";

function sql(command: string) {
	execFileSync(
		"npx",
		["wrangler", "d1", "execute", "DB", "--local", "--persist-to", E2E_PERSIST_DIR, "--command", command],
		{
			env: { ...process.env, CI: "1" },
			stdio: "pipe",
		},
	);
}

function removeFixtures() {
	sql("DELETE FROM outbound_jobs WHERE id LIKE 'job_e2e_%'");
}

function insertStuckJob() {
	sql(
		"INSERT INTO outbound_jobs (id, user_id, message_id, status, payload, error, scheduled_at, created_at, updated_at) " +
			"VALUES ('job_e2e_stuck', (SELECT id FROM users WHERE email='admin@example.com'), NULL, 'queued', '{}', NULL, NULL, unixepoch() - 2400, unixepoch() - 2400);",
	);
}

async function openInbox(page: Page) {
	const active = page.waitForResponse((response) => response.url().endsWith(ACTIVE_API));
	await page.goto("/inbox");
	const response = await active;
	expect(response.ok()).toBe(true);
	return (await response.json()) as { alerts: { name: string; count: number; href: string }[]; signature: string };
}

test.describe("operational alerts banner", () => {
	test.beforeAll(() => {
		removeFixtures();
		insertStuckJob();
	});

	test.afterAll(() => {
		removeFixtures();
	});

	test.afterEach(async () => {
		const api = await apiContext(STORAGE_STATE);
		const cleared = await api.delete("/api/admin/alerts/webhook");
		expect(cleared.ok(), await cleared.text()).toBe(true);
		await api.dispose();
	});

	test("an admin sees the stuck queue and can dismiss it across reloads", async ({ page }) => {
		const data = await openInbox(page);
		expect(data.alerts.map((alert) => alert.name)).toContain(STUCK_NAME);

		const banner = page.getByRole("region", { name: "Operational alerts" });
		await expect(banner).toBeVisible();
		const entry = banner.getByRole("listitem").filter({ hasText: STUCK_NAME });
		await expect(entry).toContainText("1");
		await expect(entry.getByRole("link", { name: STUCK_NAME })).toHaveAttribute("href", "/admin");
		await expect(page.getByRole("main")).toBeVisible();

		await banner.getByRole("button", { name: "Dismiss" }).click();
		await expect(banner).toBeHidden();
		expect(await page.evaluate((key) => localStorage.getItem(key), DISMISSED_KEY)).toBe(data.signature);

		await openInbox(page);
		await expect(page.getByRole("main")).toBeVisible();
		await expect(page.getByRole("region", { name: "Operational alerts" })).toBeHidden();
	});

	test("no banner is shown once nothing is active", async ({ page }) => {
		removeFixtures();
		try {
			const data = await openInbox(page);
			expect(data.alerts).toEqual([]);
			await expect(page.getByRole("main")).toBeVisible();
			await expect(page.getByRole("region", { name: "Operational alerts" })).toHaveCount(0);
		} finally {
			insertStuckJob();
		}
	});

	test("returning to the dashboard refreshes cached alerts without a reload", async ({ page }) => {
		removeFixtures();
		try {
			const empty = await openInbox(page);
			expect(empty.alerts).toEqual([]);
			await expect(page.getByRole("region", { name: "Operational alerts" })).toHaveCount(0);
			await page.evaluate(() => {
				(window as Window & { __bannerNoReload?: boolean }).__bannerNoReload = true;
			});

			await page.getByRole("button", { name: "Open account menu" }).click();
			await page.getByRole("link", { name: "Admin", exact: true }).click();
			await expect(page).toHaveURL(/\/admin$/);
			insertStuckJob();

			const refreshed = page.waitForResponse((response) => response.url().endsWith(ACTIVE_API));
			await page.locator('a[href="/inbox"]').first().click();
			await expect(page).toHaveURL(/\/inbox/);
			const data = (await (await refreshed).json()) as { alerts: { name: string }[] };
			expect(data.alerts.map((alert) => alert.name)).toContain(STUCK_NAME);

			const banner = page.getByRole("region", { name: "Operational alerts" });
			await expect(banner).toBeVisible();
			await expect(banner.getByRole("link", { name: STUCK_NAME })).toBeVisible();
			expect(await page.evaluate(() => (window as Window & { __bannerNoReload?: boolean }).__bannerNoReload)).toBe(
				true,
			);
		} finally {
			removeFixtures();
			insertStuckJob();
		}
	});

	test("a regular user never requests active alerts", async ({ browser }) => {
		const api = await apiContext(STORAGE_STATE);
		const domains = (await (await api.get("/api/domains")).json()) as { domains: { id: string; hostname: string }[] };
		const domain = domains.domains.find((entry) => entry.hostname === DOMAIN);
		expect(domain).toBeDefined();
		const username = uniqueToken("banner");
		const created = await api.post("/api/accounts", {
			data: { username, domainId: domain!.id, password: USER_PASSWORD, role: "user" },
		});
		expect(created.ok(), await created.text()).toBe(true);
		await api.dispose();

		const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
		const page = await context.newPage();
		const requested: string[] = [];
		page.on("request", (request) => {
			if (request.url().includes(ACTIVE_API)) requested.push(request.url());
		});
		await signIn(page, `${username}@${DOMAIN}`, USER_PASSWORD);
		await expect(page).toHaveURL(/\/inbox/);
		await page.waitForLoadState("networkidle");
		await expect(page.getByRole("region", { name: "Operational alerts" })).toHaveCount(0);
		expect(requested).toEqual([]);
		await context.close();
	});
});
