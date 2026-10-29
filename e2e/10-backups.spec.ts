import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { ADMIN, E2E_PERSIST_DIR, STORAGE_STATE, SUPPORT_ADDRESS } from "./support/constants";
import {
	apiContext,
	deliverInbound,
	readBackups,
	signIn,
	uniqueToken,
	waitForBackup,
	waitForRestore,
} from "./support/helpers";

// Restoring replaces every table, so these run in order and last in the suite.
test.describe.configure({ mode: "serial" });

const STALE_BACKUP_ID = "bak_e2e_stale";
const STALE_BACKUP_ERROR = "Backup was interrupted before it finished";

let backupFile: string;
let beforeBackupSubject: string;

/** Writes directly to the suite's D1 database, the way e2e/17-alerts-banner.spec.ts inserts alert fixtures. */
function sql(command: string) {
	execFileSync(
		"npx",
		["wrangler", "d1", "execute", "DB", "--local", "--persist-to", E2E_PERSIST_DIR, "--command", command],
		{ env: { ...process.env, CI: "1" }, stdio: "pipe" },
	);
}

test("creates a backup that completes and can be downloaded", async ({ page }) => {
	const api = await apiContext(STORAGE_STATE);
	beforeBackupSubject = `Before backup ${uniqueToken()}`;
	await deliverInbound(api, {
		from: `"Archivist" <archivist@outside.test>`,
		to: SUPPORT_ADDRESS,
		subject: beforeBackupSubject,
	});
	await api.dispose();

	await page.goto("/backups");
	await expect(page.getByRole("heading", { name: "Database Backups" })).toBeVisible();
	const before = await page.getByTitle("Download backup").count();

	await page.getByRole("button", { name: "Back up" }).click();
	await expect(page.getByTitle("Download backup")).toHaveCount(before + 1);
	const newest = page.getByTitle("Download backup").first();
	// The page polls every few seconds while a backup is queued or running.
	await expect(newest).toBeEnabled({ timeout: 60_000 });
	await expect(page.getByRole("main").getByText("completed", { exact: true }).first()).toBeVisible();

	const downloading = page.waitForEvent("download");
	await newest.click();
	const download = await downloading;
	backupFile = test.info().outputPath("backup.json");
	await download.saveAs(backupFile);
	const document = JSON.parse(readFileSync(backupFile, "utf8")) as { tables?: Record<string, unknown[]> };
	expect(document.tables).toBeDefined();
	const messages = (document.tables?.messages ?? []) as { subject?: string }[];
	expect(messages.some((message) => message.subject === beforeBackupSubject)).toBe(true);
});

test("queues a manual backup instead of exporting it inside the request", async () => {
	const api = await apiContext(STORAGE_STATE);
	const queued = await api.post("/api/backups");
	// The export runs on the outbound queue consumer, so the request returns as soon as the record exists.
	expect(queued.status()).toBe(202);
	const { backupId, status } = (await queued.json()) as { backupId: string; status: string };
	expect(status).toBe("queued");
	expect((await readBackups(api)).some((backup) => backup.id === backupId)).toBe(true);
	const finished = await waitForBackup(api, backupId);
	expect(finished.status, finished.error ?? "").toBe("completed");
	await api.dispose();
});

test("marks an interrupted backup failed and lets it be deleted", async ({ page }) => {
	// A running row that stopped reporting an hour ago: the state production was
	// stuck in when the Worker invocation was cancelled mid-export.
	sql(
		`INSERT INTO backups (id, status, trigger, created_at, started_at) ` +
			`VALUES ('${STALE_BACKUP_ID}', 'running', 'manual', unixepoch() - 3600, unixepoch() - 3600)`,
	);

	await page.goto("/backups");
	await expect(page.getByRole("heading", { name: "Database Backups" })).toBeVisible();
	// Listing recovers it, so the row shows the reason instead of running forever.
	const row = page.getByText(STALE_BACKUP_ERROR).locator("xpath=ancestor::div[contains(@class, 'items-center')][1]");
	await expect(row).toContainText(STALE_BACKUP_ID);
	await expect(row.getByText("failed", { exact: true })).toBeVisible();

	await row.getByTitle("Delete backup").click();
	const confirm = page.getByRole("alertdialog", { name: "Delete this backup?" });
	await expect(confirm).toBeVisible();
	await confirm.getByRole("button", { name: "Delete backup" }).click();
	await expect(page.getByText(STALE_BACKUP_ERROR)).toHaveCount(0);

	const api = await apiContext(STORAGE_STATE);
	expect((await readBackups(api)).some((backup) => backup.id === STALE_BACKUP_ID)).toBe(false);
	await api.dispose();
});

test("restores the downloaded backup", async ({ browser }) => {
	test.skip(!backupFile, "needs the backup from the previous test");
	const api = await apiContext(STORAGE_STATE);
	const afterBackupSubject = `After backup ${uniqueToken()}`;
	await deliverInbound(api, {
		from: `"Archivist" <archivist@outside.test>`,
		to: SUPPORT_ADDRESS,
		subject: afterBackupSubject,
	});
	await api.dispose();

	// A fresh session, because a restore may sign everyone out.
	const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
	const page = await context.newPage();
	await signIn(page, ADMIN.email, ADMIN.password);
	await expect(page).toHaveURL(/\/inbox/);
	await page.goto("/backups");
	await expect(page.getByRole("heading", { name: "Database Backups" })).toBeVisible();

	await page.getByRole("button", { name: "Backup actions" }).click();
	const chooser = page.waitForEvent("filechooser");
	await page.getByRole("menuitem", { name: "Restore from backup" }).click();
	await (await chooser).setFiles(backupFile);
	const confirm = page.getByRole("alertdialog", { name: "Restore this backup?" });
	await expect(confirm).toBeVisible();
	await confirm.getByRole("button", { name: "Restore" }).click();
	await expect(page).toHaveURL(/\/login/, { timeout: 60_000 });
	// The restore runs as a queued job; the page signs out as soon as it replaces the sessions.
	const restore = await waitForRestore();
	expect(restore.status, restore.error ?? "").toBe("completed");

	await signIn(page, ADMIN.email, ADMIN.password);
	await expect(page).toHaveURL(/\/inbox/);
	await expect(page.getByRole("main").getByText(beforeBackupSubject, { exact: true })).toBeVisible();
	await expect(page.getByRole("main").getByText(afterBackupSubject, { exact: true })).toHaveCount(0);
	await context.close();
});
