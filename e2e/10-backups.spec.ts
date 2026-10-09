import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { ADMIN, STORAGE_STATE, SUPPORT_ADDRESS } from "./support/constants";
import { apiContext, deliverInbound, signIn, uniqueToken } from "./support/helpers";

// Restoring replaces every table, so these run in order and last in the suite.
test.describe.configure({ mode: "serial" });

let backupFile: string;
let beforeBackupSubject: string;

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

	await signIn(page, ADMIN.email, ADMIN.password);
	await expect(page).toHaveURL(/\/inbox/);
	await expect(page.getByRole("main").getByText(beforeBackupSubject, { exact: true })).toBeVisible();
	await expect(page.getByRole("main").getByText(afterBackupSubject, { exact: true })).toHaveCount(0);
	await context.close();
});
