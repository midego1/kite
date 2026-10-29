import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { ADMIN, DOMAIN, E2E_PERSIST_DIR, STORAGE_STATE } from "./support/constants";
import { apiContext, readBackups, signIn, waitForBackup } from "./support/helpers";

// Restoring replaces every table, so these run in order; the restored backup is taken here, moments earlier.
test.describe.configure({ mode: "serial" });

const BULK = 3000;
const BULK_PREFIX = "e2e_bulk_restore_";

/** Runs SQL on the suite's D1 database, the way e2e/10-backups.spec.ts does, and returns the first result set. */
function sql<T = Record<string, unknown>>(command: string): T[] {
	const output = execFileSync(
		"npx",
		["wrangler", "d1", "execute", "DB", "--local", "--persist-to", E2E_PERSIST_DIR, "--json", "--command", command],
		{ env: { ...process.env, CI: "1" }, stdio: "pipe" },
	).toString("utf8");
	const parsed = JSON.parse(output.slice(output.indexOf("["))) as { results: T[] }[];
	return parsed[0]?.results ?? [];
}

function bulkCount(): number {
	return Number(
		sql<{ total: number }>(`SELECT COUNT(*) AS total FROM messages WHERE id LIKE '${BULK_PREFIX}%'`)[0]?.total,
	);
}

let backupId = "";

test.afterAll(() => {
	sql(`DELETE FROM messages WHERE id LIKE '${BULK_PREFIX}%'`);
});

test("restores a backup of several thousand messages straight from storage", async ({ browser }) => {
	test.setTimeout(240_000);
	// Archived, so the bulk stays out of the Inbox other specs read.
	sql(
		`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${BULK}) ` +
			`INSERT INTO messages (id, user_id, mailbox_id, direction, from_addr, to_addr, subject, text_body, status, created_at) ` +
			`SELECT '${BULK_PREFIX}' || i, m.user_id, m.id, 'inbound', 'bulk@outside.test', 'support@${DOMAIN}', ` +
			`'Bulk restore ' || i, 'Body of bulk message ' || i || ' ' || hex(randomblob(64)), 'archived', unixepoch() - i ` +
			`FROM n, mailboxes m JOIN domains d ON d.id = m.domain_id WHERE m.local_part = 'support' AND d.hostname = '${DOMAIN}'`,
	);
	expect(bulkCount()).toBe(BULK);

	const api = await apiContext(STORAGE_STATE);
	const queued = await api.post("/api/backups");
	expect(queued.status()).toBe(202);
	backupId = ((await queued.json()) as { backupId: string }).backupId;
	const backup = await waitForBackup(api, backupId);
	expect(backup.status, backup.error ?? "").toBe("completed");

	// Changes after the backup that the restore must undo.
	sql(
		`DELETE FROM messages WHERE id LIKE '${BULK_PREFIX}%' AND CAST(substr(id, ${BULK_PREFIX.length + 1}) AS INTEGER) <= 1000`,
	);
	expect(bulkCount()).toBe(BULK - 1000);

	// A fresh session, because a restore may sign everyone out.
	const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
	const page = await context.newPage();
	await signIn(page, ADMIN.email, ADMIN.password);
	await expect(page).toHaveURL(/\/inbox/);
	await page.goto("/backups");
	const row = page
		.getByText(backup.filename!, { exact: true })
		.locator("xpath=ancestor::div[contains(@class, 'items-center')][1]");
	await row.getByTitle("Restore this backup").click();
	const confirm = page.getByRole("alertdialog", { name: "Restore this backup?" });
	await confirm.getByRole("button", { name: "Restore" }).click();
	await expect(page).toHaveURL(/\/login/, { timeout: 180_000 });
	await context.close();

	expect(bulkCount()).toBe(BULK);
	const backups = await readBackups(api);
	// The restored backup is newer than the data it restored and stays listed, next to the safety backup.
	expect(backups.find((item) => item.id === backupId)?.status).toBe("completed");
	expect(backups.some((item) => item.trigger === "pre-restore" && item.status === "completed")).toBe(true);
	await api.dispose();
});

test("the admin overview shows the last successful backup and warns when the last run failed", async ({ page }) => {
	await page.goto("/admin");
	const card = page.getByTestId("backup-health-card");
	// The first visit may compile the page.
	await expect(card).toContainText("Last successful backup", { timeout: 60_000 });
	await expect(card).toContainText(/took \d+/);
	await expect(card).toContainText(/\d+(\.\d)? (B|KB|MB|GB)/);
	await expect(card.getByRole("alert")).toHaveCount(0);

	// A failed run is hard to cause on purpose; the server side of this state is covered by tests/backup-health.test.mjs.
	await page.route("**/api/backups/health", (route) =>
		route.fulfill({
			json: {
				level: "failed",
				lastSuccess: null,
				lastFailure: {
					id: "bak_failed",
					trigger: "scheduled",
					failedAt: new Date().toISOString(),
					error: "Backup was interrupted before it finished",
				},
				inProgress: false,
				automatic: { enabled: true, scheduleType: "daily", retentionEnabled: true, retentionDays: 14 },
			},
		}),
	);
	await page.reload();
	await expect(card).toHaveAttribute("data-level", "failed");
	await expect(card.getByRole("alert")).toContainText("The last backup failed");
	await expect(card.getByRole("alert")).toContainText("Backup was interrupted before it finished");
	await expect(card).toContainText("No successful backup yet.");
	await expect(card).toContainText("Automatic backups run daily and are kept for 14 days.");
});
