import { expect, test, type Locator, type Page } from "@playwright/test";
import { STORAGE_STATE } from "./support/constants";
import { createFolder, driveAccount, listItems, signedInPage, uploadFile } from "./support/drive";
import { apiContext, deliverInbound, openMessage, uniqueToken } from "./support/helpers";

const row = (page: Page, name: string) => page.locator(`[data-drive-item="${name}"]`);

async function rowAction(page: Page, name: string, action: string) {
	await page.getByRole("button", { name: `Actions for ${name}` }).click();
	await page.getByRole("menuitem", { name: action, exact: true }).click();
}

async function chooseFolder(dialog: Locator, folder: string, verb: string) {
	await dialog.getByRole("button", { name: folder }).click();
	await dialog.getByRole("button", { name: `${verb} to ${folder}` }).click();
	await expect(dialog).toHaveCount(0);
}

test("My Drive: a folder, an upload, preview, rename, move, trash, restore and delete forever", async ({ browser }) => {
	test.setTimeout(120_000);
	const admin = await apiContext(STORAGE_STATE);
	const account = await driveAccount(admin, "drvfiles");
	const { context, page } = await signedInPage(browser, account);
	try {
		await page.goto("/drive");
		await expect(page.getByRole("heading", { level: 1, name: "My Drive" })).toBeVisible();
		await expect(page.getByText("Nothing here yet. Upload files or create a folder.")).toBeVisible();

		await page.getByRole("button", { name: "New folder" }).click();
		const create = page.getByRole("dialog", { name: "New folder" });
		await create.getByLabel("Name").fill("Projects");
		await create.getByRole("button", { name: "Create" }).click();
		await expect(row(page, "Projects")).toBeVisible();

		await page.locator("input[data-drive-file-input]").setInputFiles({
			name: "hello.txt",
			mimeType: "text/plain",
			buffer: Buffer.from("Hello from Drive"),
		});
		await expect(page.getByRole("region", { name: "Uploads" }).getByLabel("Uploaded")).toBeVisible();
		await expect(row(page, "hello.txt")).toBeVisible();
		await expect(row(page, "hello.txt")).toContainText("16 B");

		await row(page, "hello.txt").getByRole("button", { name: "hello.txt", exact: true }).click();
		const preview = page.locator("[data-drive-preview]");
		await expect(preview).toBeVisible();
		await expect(preview.frameLocator('iframe[title="hello.txt"]').getByText("Hello from Drive")).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(preview).toHaveCount(0);

		await rowAction(page, "hello.txt", "Rename");
		const rename = page.getByRole("dialog", { name: "Rename" });
		await rename.getByLabel("Name").fill("renamed.txt");
		await rename.getByRole("button", { name: "Save" }).click();
		await expect(row(page, "renamed.txt")).toBeVisible();
		await expect(row(page, "hello.txt")).toHaveCount(0);

		await rowAction(page, "renamed.txt", "Move");
		await chooseFolder(page.locator("[data-drive-folder-dialog]"), "Projects", "Move");
		await expect(row(page, "renamed.txt")).toHaveCount(0);
		await row(page, "Projects").getByRole("button", { name: "Projects", exact: true }).click();
		await expect(page.getByRole("heading", { level: 1, name: "Projects" })).toBeVisible();
		await expect(
			page.getByRole("navigation", { name: "Folder path" }).getByRole("link", { name: "My Drive" }),
		).toBeVisible();
		await expect(row(page, "renamed.txt")).toBeVisible();

		await rowAction(page, "renamed.txt", "Move to trash");
		await expect(row(page, "renamed.txt")).toHaveCount(0);
		await page.goto("/drive/trash");
		await expect(row(page, "renamed.txt")).toBeVisible();
		await rowAction(page, "renamed.txt", "Restore");
		await expect(row(page, "renamed.txt")).toHaveCount(0);
		const [file] = (
			await listItems(
				account.api,
				`parent=${(await listItems(account.api)).find((item) => item.name === "Projects")!.id}`,
			)
		).filter((item) => item.name === "renamed.txt");
		expect(file).toBeDefined();
		expect(await (await account.api.get(`/api/drive/files/${file.id}/content`)).text()).toBe("Hello from Drive");

		expect((await account.api.post("/api/drive/items/bulk", { data: { ids: [file.id], action: "trash" } })).ok()).toBe(
			true,
		);
		await page.reload();
		await rowAction(page, "renamed.txt", "Delete forever");
		await page.getByRole("alertdialog").getByRole("button", { name: "Delete forever" }).click();
		await expect(row(page, "renamed.txt")).toHaveCount(0);
		await expect(page.getByText("The trash is empty.")).toBeVisible();
		expect((await account.api.get(`/api/drive/files/${file.id}/content`)).status()).toBe(404);
	} finally {
		await context.close();
		await account.api.dispose();
		await admin.dispose();
	}
});

test("a file of two parts uploads, downloads whole and answers a byte range", async () => {
	test.setTimeout(120_000);
	const admin = await apiContext(STORAGE_STATE);
	const account = await driveAccount(admin, "drvparts");
	try {
		const size = 32 * 1024 * 1024 + 1000;
		const content = Buffer.alloc(size, 7);
		content.write("TAIL", size - 4);
		const item = await uploadFile(account.api, "large.bin", content, { contentType: "application/octet-stream" });
		expect(item.size).toBe(size);
		const whole = await account.api.get(`/api/drive/files/${item.id}/content?disposition=attachment`);
		expect(whole.status()).toBe(200);
		expect(whole.headers()["content-disposition"]).toContain("attachment");
		expect(whole.headers()["content-disposition"]).toContain("large.bin");
		expect((await whole.body()).length).toBe(size);
		const tail = await account.api.get(`/api/drive/files/${item.id}/content`, { headers: { Range: "bytes=-4" } });
		expect(tail.status()).toBe(206);
		expect(tail.headers()["content-range"]).toBe(`bytes ${size - 4}-${size - 1}/${size}`);
		expect(await tail.text()).toBe("TAIL");
		const unsatisfiable = await account.api.get(`/api/drive/files/${item.id}/content`, {
			headers: { Range: `bytes=${size}-` },
		});
		expect(unsatisfiable.status()).toBe(416);
	} finally {
		await account.api.dispose();
		await admin.dispose();
	}
});

test("Save to Drive from a message attachment puts it in the chosen folder, and All attachments lists it", async ({
	browser,
}) => {
	test.setTimeout(120_000);
	const admin = await apiContext(STORAGE_STATE);
	const account = await driveAccount(admin, "drvsave");
	const { context, page } = await signedInPage(browser, account);
	try {
		const folder = await createFolder(account.api, "Receipts");
		const filename = `${uniqueToken("receipt")}.txt`;
		const subject = `Receipt ${uniqueToken("mail")}`;
		await deliverInbound(account.api, {
			from: "Shop <shop@outside.test>",
			to: account.email,
			subject,
			attachments: [{ filename, contentType: "text/plain", content: "Total: 12.00" }],
		});

		await page.goto("/inbox");
		await openMessage(page, subject);
		await page.getByRole("button", { name: `More actions for ${filename}` }).click();
		await page
			.getByRole("dialog", { name: `Actions for ${filename}` })
			.getByRole("button", { name: "Save to Drive" })
			.click();
		await chooseFolder(page.locator("[data-drive-folder-dialog]"), "Receipts", "Save");
		await expect(page.getByText("Saved to Receipts")).toBeVisible();

		const saved = (await listItems(account.api, `parent=${folder.id}`)).find((item) => item.name === filename);
		expect(saved).toMatchObject({ kind: "file", size: "Total: 12.00".length });
		expect(await (await account.api.get(`/api/drive/files/${saved!.id}/content`)).text()).toBe("Total: 12.00");

		await page.goto("/drive/attachments");
		await expect(page.getByRole("heading", { level: 1, name: "All attachments" })).toBeVisible();
		await expect(row(page, filename)).toBeVisible();
		await expect(row(page, filename)).toContainText("Shop");
		await rowAction(page, filename, "Open email");
		await expect(page).toHaveURL(/\/inbox\//);
		await expect(page.getByRole("heading", { name: subject })).toBeVisible();
	} finally {
		await context.close();
		await account.api.dispose();
		await admin.dispose();
	}
});

test("a storage override refuses an upload that does not fit, and the sidebar shows the usage", async ({ browser }) => {
	test.setTimeout(120_000);
	const admin = await apiContext(STORAGE_STATE);
	const account = await driveAccount(admin, "drvquota");
	const { context, page } = await signedInPage(browser, account);
	try {
		expect((await admin.put(`/api/drive/settings/quotas/${account.id}`, { data: { quotaBytes: 1000 } })).ok()).toBe(
			true,
		);
		await uploadFile(account.api, "small.txt", "x".repeat(600));
		const refused = await account.api.post("/api/drive/uploads", {
			data: { name: "big.txt", size: 600, contentType: "text/plain", parentId: null, fingerprint: "big" },
		});
		expect(refused.status()).toBe(413);
		expect((await refused.json()).error).toBe("Not enough Drive storage left for this file");

		await page.goto("/drive");
		const usage = page.getByRole("progressbar", { name: "Drive storage used" });
		await expect(usage).toHaveAttribute("aria-valuenow", "60");
		await expect(page.getByText("600 B of 1000 B used")).toBeVisible();
		await page.locator("input[data-drive-file-input]").setInputFiles({
			name: "big.txt",
			mimeType: "text/plain",
			buffer: Buffer.from("y".repeat(600)),
		});
		await expect(page.getByRole("region", { name: "Uploads" })).toContainText(
			"Not enough Drive storage left for this file",
		);
		await expect(row(page, "big.txt")).toHaveCount(0);
	} finally {
		await admin.delete(`/api/drive/settings/quotas/${account.id}`);
		await context.close();
		await account.api.dispose();
		await admin.dispose();
	}
});

test("Admin → Drive saves the defaults and lists usage, and is not found for a member", async ({ page, browser }) => {
	const admin = await apiContext(STORAGE_STATE);
	const member = await driveAccount(admin, "drvmember");
	const { context, page: memberPage } = await signedInPage(browser, member);
	const before = await (await admin.get("/api/drive/settings")).json();
	try {
		await page.goto("/admin");
		await page.getByRole("complementary", { name: "Admin menu" }).getByRole("link", { name: "Drive" }).click();
		await expect(page).toHaveURL(/\/drive\/settings$/);
		await expect(page.getByRole("heading", { level: 1, name: "Drive" })).toBeVisible();
		// The form is disabled and shows an unchecked box until the settings load. check() reads the state first, so
		// on a slow load it would see that placeholder and then click the loaded, already checked box off.
		await expect(page.getByLabel("Keep trashed items for (days)")).toHaveValue(
			String(before.settings.trashRetentionDays),
		);
		await page.getByLabel("Allow public links").check();
		await page.getByLabel("Longest link lifetime (days)").fill("");
		await page.getByRole("button", { name: "Save settings" }).click();
		await expect(
			page.getByRole("status").filter({ hasText: "Enter a link lifetime from 1 to 365 days" }),
		).toBeVisible();
		expect((await (await admin.get("/api/drive/settings")).json()).settings).toEqual(before.settings);
		await page.getByLabel("Longest link lifetime (days)").fill("30");
		await page.getByLabel("Keep trashed items for (days)").fill("");
		await page.getByRole("button", { name: "Save settings" }).click();
		await expect(
			page.getByRole("status").filter({ hasText: "Enter a trash retention from 1 to 365 days" }),
		).toBeVisible();
		expect((await (await admin.get("/api/drive/settings")).json()).settings).toEqual(before.settings);
		await page.getByLabel("Keep trashed items for (days)").fill("45");
		await page.getByRole("button", { name: "Save settings" }).click();
		await expect(page.getByRole("status").filter({ hasText: "Drive settings saved" })).toBeVisible();
		expect((await (await admin.get("/api/drive/settings")).json()).settings.trashRetentionDays).toBe(45);
		await expect(page.getByLabel(`Storage override for ${member.email} (GB)`)).toBeVisible();

		const response = await memberPage.goto("/drive/settings");
		expect(response?.status()).toBe(404);
		expect((await member.api.get("/api/drive/settings")).status()).toBe(403);
	} finally {
		await admin.patch("/api/drive/settings", { data: before.settings });
		await context.close();
		await member.api.dispose();
		await admin.dispose();
	}
});
