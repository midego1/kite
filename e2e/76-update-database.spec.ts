import { expect, test } from "@playwright/test";
import { ADMIN, DOMAIN, STORAGE_STATE } from "./support/constants";
import { apiContext, signIn, uniqueToken } from "./support/helpers";

const STATUS_API = "/api/admin/migrations";
const PENDING_API = "/api/migrations/pending";
const NAMES = ["0101_add_column.sql", "0102_add_table.sql"];
const PASSWORD = "update-database-admin-123";

test("the primary admin sees the pending migrations, the safety backup and a prominent Update database button", async ({
	page,
}) => {
	let pending = [...NAMES];
	const posts: string[] = [];
	await page.route(`**${STATUS_API}`, async (route) => {
		if (route.request().method() === "POST") {
			posts.push("POST");
			const applied = pending;
			pending = [];
			await route.fulfill({ json: { ready: true, pending, unknown: [], applied, backupId: "bak_e2e" } });
			return;
		}
		await route.fulfill({ json: { ready: true, pending, unknown: [] } });
	});

	await page.goto("/admin");
	const panel = page.getByRole("region", { name: "Pending database updates" });
	await expect(panel).toBeVisible();
	await expect(panel).toContainText("2 database updates are waiting");
	await expect(panel.getByRole("list", { name: "Pending migrations" }).getByRole("listitem")).toHaveText(NAMES);
	await expect(panel).toContainText("Kite saves a safety backup of the database when there is data to save");
	await expect(panel.getByRole("link", { name: "Backups" })).toHaveAttribute("href", "/backups");

	const button = panel.getByRole("button", { name: "Update database" });
	// A full-size button, not a small link or a compact one.
	expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(40);
	await button.click();

	await expect(panel).toHaveCount(0);
	await expect(page.getByText("The database schema is up to date.")).toBeVisible();
	await expect(page.getByText("2 database updates applied. A safety backup was saved first.")).toBeVisible();
	expect(posts).toEqual(["POST"]);
});

test("another admin sees what is waiting and who can apply it, without a button", async ({ browser }) => {
	const api = await apiContext(STORAGE_STATE);
	const domains = (await (await api.get("/api/domains")).json()) as { domains: { id: string; hostname: string }[] };
	const username = uniqueToken("updadmin");
	const created = await api.post("/api/accounts", {
		data: {
			username,
			domainId: domains.domains.find((domain) => domain.hostname === DOMAIN)!.id,
			password: PASSWORD,
			role: "admin",
			useAllDomains: false,
		},
	});
	expect(created.ok(), await created.text()).toBe(true);
	const { account } = (await created.json()) as { account: { id: string } };

	const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
	const page = await context.newPage();
	try {
		// The real endpoint names the primary admin only while something is pending (unit-tested); here it is.
		await page.route(`**${PENDING_API}`, (route) =>
			route.fulfill({ json: { pending: 2, appliedBy: { name: ADMIN.name, email: ADMIN.email } } }),
		);
		await signIn(page, `${username}@${DOMAIN}`, PASSWORD);
		await expect(page).toHaveURL(/\/inbox/);

		const who = `Only the primary admin, ${ADMIN.name} (${ADMIN.email}), can apply them.`;
		await expect(page.getByRole("region", { name: "Database updates" })).toContainText(who);

		await page.goto("/admin");
		const panel = page.getByRole("region", { name: "Pending database updates" });
		await expect(panel).toBeVisible();
		await expect(panel).toContainText("2 database updates are waiting");
		await expect(panel).toContainText(who);
		await expect(page.getByRole("button", { name: "Update database" })).toHaveCount(0);
		// The migration list stays with the primary admin.
		await expect(panel.getByRole("list", { name: "Pending migrations" })).toHaveCount(0);
	} finally {
		await context.close();
		// There is no account deletion; a disabled member is as good as gone for every other spec.
		const retired = await api.patch(`/api/accounts/${account.id}`, {
			data: { name: username, role: "user", disabled: true, canManageMailboxes: false, canManageDomains: false },
		});
		expect(retired.ok(), await retired.text()).toBe(true);
		await api.dispose();
	}
});
