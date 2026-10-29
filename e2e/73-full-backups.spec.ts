import { expect, test } from "@playwright/test";
import { STORAGE_STATE, SUPPORT_ADDRESS } from "./support/constants";
import { apiContext, deliverInbound, readBackups, uniqueToken } from "./support/helpers";

// These change the install's backup settings, so they run in order and put them back.
test.describe.configure({ mode: "serial" });

type Settings = Record<string, unknown> & { enabled: boolean; includeObjects: boolean };

async function readSettings(): Promise<Settings> {
	const api = await apiContext(STORAGE_STATE);
	const data = (await (await api.get("/api/backups")).json()) as { settings: Settings };
	await api.dispose();
	return data.settings;
}

async function saveSettings(settings: Settings): Promise<void> {
	const api = await apiContext(STORAGE_STATE);
	const response = await api.put("/api/backups", { data: settings });
	expect(response.ok(), await response.text()).toBe(true);
	await api.dispose();
}

let original: Settings;

test.beforeAll(async () => {
	original = await readSettings();
});

test.afterAll(async () => {
	if (original) await saveSettings(original);
});

test("retention stays visible and editable while automatic backups are off", async ({ page }) => {
	await saveSettings({ ...original, enabled: false });
	await page.goto("/backups");
	await expect(page.getByLabel("Enable Automatic backup")).not.toBeChecked({ timeout: 60_000 });
	await expect(page.getByLabel("Delete old backups automatically")).toBeVisible();
	await expect(page.getByLabel("Delete backups older than")).toBeVisible();
	await expect(page.getByLabel("Frequency")).toHaveCount(0);
});

test("a full backup copies the mail files and restores them", async ({ page }) => {
	test.setTimeout(180_000);
	const api = await apiContext(STORAGE_STATE);
	await deliverInbound(api, {
		from: `"Archivist" <archivist@outside.test>`,
		to: SUPPORT_ADDRESS,
		subject: `Full backup ${uniqueToken()}`,
	});

	await page.goto("/backups");
	const estimate = page.getByTestId("backup-objects-estimate");
	// The size is shown before a full backup ever runs.
	await expect(estimate).toContainText(/About [\d,]+ files, [\d.]+ (B|KB|MB)/, { timeout: 60_000 });
	const toggle = page.getByLabel("Include mail files");
	await expect(toggle).not.toBeChecked();
	await toggle.click();
	await expect(toggle).toBeChecked();
	expect((await readSettings()).includeObjects).toBe(true);

	const before = new Set((await readBackups(api)).map((backup) => backup.id));
	await page.getByRole("button", { name: "Back up" }).click();
	let backupId = "";
	await expect
		.poll(
			async () => {
				const backup = (await readBackups(api)).find((item) => !before.has(item.id) && item.status !== "failed");
				backupId = backup?.id ?? "";
				return backup?.objectsStatus;
			},
			{ timeout: 120_000, intervals: [500, 1000, 2000] },
		)
		.toBe("completed");
	const done = (await readBackups(api)).find((item) => item.id === backupId)!;
	expect(done.objectsCount).toBeGreaterThan(0);

	const row = page
		.getByText(done.filename!, { exact: true })
		.locator("xpath=ancestor::div[contains(@class, 'items-center')][1]");
	await expect(row).toContainText(/With [\d,]+ mail files/);
	await row.getByTitle("Restore mail files").click();
	const confirm = page.getByRole("alertdialog", { name: "Restore the mail files of this backup?" });
	const started = page.waitForResponse(
		(response) => response.url().endsWith(`/api/backups/${backupId}/objects`) && response.request().method() === "POST",
	);
	await confirm.getByRole("button", { name: "Restore files" }).click();
	expect((await started).status()).toBe(202);
	// Nothing was lost, so every file is left as it is and the backup is back to completed.
	await expect
		.poll(async () => (await readBackups(api)).find((item) => item.id === backupId)?.objectsStatus, {
			timeout: 120_000,
			intervals: [500, 1000, 2000],
		})
		.toBe("completed");

	// Deleting the backup also removes its copied files (on the queue).
	const removed = await api.delete(`/api/backups/${backupId}`);
	expect(removed.ok(), await removed.text()).toBe(true);
	await api.dispose();
});
