import { expect, test, type Page } from "@playwright/test";
import { startFakeWebdav } from "../tests/support/fake-webdav.mjs";
import { BASE_URL, STORAGE_STATE } from "./support/constants";
import { driveAccount, signedInPage, sql } from "./support/drive";
import { apiContext, deliverInbound, openMessage, suppressMailboxTour, uniqueToken } from "./support/helpers";
import { chooseOption } from "./support/select";

const row = (page: Page, name: string) => page.locator(`[data-drive-item="${name}"]`);

async function rowAction(page: Page, name: string, action: string) {
	await page.getByRole("button", { name: `Actions for ${name}` }).click();
	await page.getByRole("menuitem", { name: action, exact: true }).click();
}

async function linkFolder(page: Page, fields: { url: string; username: string; password: string; label: string }) {
	await page.getByRole("button", { name: "Link a folder" }).click();
	const dialog = page.getByRole("dialog", { name: "Link a folder" });
	await dialog.getByLabel("WebDAV address").fill(fields.url);
	await dialog.getByLabel("Username").fill(fields.username);
	await dialog.getByLabel("App password").fill(fields.password);
	await dialog.getByLabel("Name in Drive").fill(fields.label);
	await dialog.getByRole("button", { name: "Link folder" }).click();
	return dialog;
}

test("a linked WebDAV folder: link, browse, upload, download, rename, move, delete and Save to Drive", async ({
	browser,
}) => {
	test.setTimeout(150_000);
	const fake = await startFakeWebdav({
		files: { "/Docs": null, "/Docs/readme.txt": "Hello from the NAS", "/Archive": null },
	});
	const admin = await apiContext(STORAGE_STATE);
	const account = await driveAccount(admin, "drvdav");
	const { context, page } = await signedInPage(browser, account);
	const label = `Nextcloud ${uniqueToken("")}`;
	try {
		await page.goto("/drive");
		const dialog = await linkFolder(page, { url: fake.url, username: fake.username, password: fake.password, label });
		await expect(dialog).toHaveCount(0);
		await expect(page).toHaveURL(/\/drive\/m\/dmt_/);
		await expect(page.getByRole("heading", { level: 1, name: label })).toBeVisible();
		await expect(page.getByRole("link", { name: label })).toHaveAttribute("aria-current", "page");
		const mountId = decodeURIComponent(new URL(page.url()).pathname.split("/").pop()!);

		// The app password is never sent back.
		const { mounts } = await (await account.api.get("/api/drive/mounts")).json();
		expect(mounts).toEqual([expect.objectContaining({ id: mountId, label, username: fake.username, status: "ok" })]);
		expect(JSON.stringify(mounts)).not.toContain(fake.password);

		await expect(row(page, "Archive")).toBeVisible();
		await row(page, "Docs").getByRole("button", { name: "Docs", exact: true }).click();
		await expect(page.getByRole("navigation", { name: "Folder path" })).toContainText("Docs");
		await expect(row(page, "readme.txt")).toBeVisible();

		await page.locator("[data-drive-file-input]").setInputFiles({
			name: "notes.txt",
			mimeType: "text/plain",
			buffer: Buffer.from("Uploaded through Kite"),
		});
		await expect(row(page, "notes.txt")).toBeVisible();
		expect(fake.file("/Docs/notes.txt")).toBe("Uploaded through Kite");

		const download = await account.api.get(
			`/api/drive/mounts/${mountId}/content?${new URLSearchParams({ path: "/Docs/readme.txt", disposition: "attachment" })}`,
		);
		expect(download.status()).toBe(200);
		expect(download.headers()["content-disposition"]).toContain("attachment");
		expect(await download.text()).toBe("Hello from the NAS");
		const range = await account.api.get(
			`/api/drive/mounts/${mountId}/content?${new URLSearchParams({ path: "/Docs/readme.txt" })}`,
			{ headers: { Range: "bytes=0-4" } },
		);
		expect(range.status()).toBe(206);
		expect(await range.text()).toBe("Hello");

		await rowAction(page, "notes.txt", "Rename");
		const rename = page.getByRole("dialog", { name: "Rename" });
		await rename.getByLabel("Name").fill("minutes.txt");
		await rename.getByRole("button", { name: "Save" }).click();
		await expect(row(page, "minutes.txt")).toBeVisible();
		expect(fake.file("/Docs/minutes.txt")).toBe("Uploaded through Kite");
		expect(fake.items.has("/Docs/notes.txt")).toBe(false);

		await rowAction(page, "minutes.txt", "Move");
		const move = page.locator("[data-drive-folder-dialog]");
		await move.getByRole("button", { name: label, exact: true }).click();
		await move.getByRole("button", { name: "Archive", exact: true }).click();
		await move.getByRole("button", { name: "Move to Archive" }).click();
		await expect(move).toHaveCount(0);
		await expect(row(page, "minutes.txt")).toHaveCount(0);
		expect(fake.file("/Archive/minutes.txt")).toBe("Uploaded through Kite");

		await rowAction(page, "readme.txt", "Delete");
		const confirm = page.getByRole("alertdialog", { name: "Delete “readme.txt”?" });
		await expect(confirm).toContainText("no trash in Kite");
		await confirm.getByRole("button", { name: "Delete" }).click();
		await expect(row(page, "readme.txt")).toHaveCount(0);
		expect(fake.items.has("/Docs/readme.txt")).toBe(false);

		// Save to Drive can put an attachment in the linked folder instead of My Drive.
		const filename = `${uniqueToken("invoice")}.txt`;
		const subject = `Invoice ${uniqueToken("mail")}`;
		await deliverInbound(account.api, {
			from: "Shop <shop@outside.test>",
			to: account.email,
			subject,
			attachments: [{ filename, contentType: "text/plain", content: "Total: 42.00" }],
		});
		await page.goto("/inbox");
		await openMessage(page, subject);
		await page.getByRole("button", { name: `More actions for ${filename}` }).click();
		await page
			.getByRole("dialog", { name: `Actions for ${filename}` })
			.getByRole("button", { name: "Save to Drive" })
			.click();
		const save = page.locator("[data-drive-folder-dialog]");
		await chooseOption(save.getByLabel("Save in"), { label });
		await save.getByRole("button", { name: "Docs", exact: true }).click();
		await save.getByRole("button", { name: "Save to Docs" }).click();
		await expect(save).toHaveCount(0);
		await expect(page.getByText("Saved to Docs")).toBeVisible();
		expect(fake.file(`/Docs/${filename}`)).toBe("Total: 42.00");

		// Nothing below the linked folder is reachable, and another user's folder answers 404.
		const outside = await account.api.get(`/api/drive/mounts/${mountId}/items?path=${encodeURIComponent("/../..")}`);
		expect(outside.status()).toBe(400);
		const stranger = await driveAccount(admin, "drvdavx");
		try {
			expect((await stranger.api.get(`/api/drive/mounts/${mountId}/items`)).status()).toBe(404);
		} finally {
			await stranger.api.dispose();
		}

		await page.goto(`/drive/m/${mountId}`);
		await page.getByRole("button", { name: "Linked folder settings" }).click();
		await page.getByRole("menuitem", { name: "Unlink folder" }).click();
		await page.getByRole("alertdialog").getByRole("button", { name: "Unlink" }).click();
		await expect(page).toHaveURL(/\/drive$/);
		await expect(page.getByRole("link", { name: label })).toHaveCount(0);
		expect(fake.items.has("/Docs")).toBe(true);
	} finally {
		await context.close();
		await account.api.dispose();
		await admin.dispose();
		await fake.close();
	}
});

test("a wrong app password is refused when linking, and a revoked one asks for the new password", async ({
	browser,
}) => {
	test.setTimeout(120_000);
	const fake = await startFakeWebdav({ files: { "/report.pdf": "%PDF-1.4" } });
	const admin = await apiContext(STORAGE_STATE);
	const account = await driveAccount(admin, "drvdavpw");
	const { context, page } = await signedInPage(browser, account);
	const label = `NAS ${uniqueToken("")}`;
	try {
		// Private addresses are refused before anything is sent.
		const blocked = await account.api.post("/api/drive/mounts", {
			data: { url: "https://10.0.0.8/dav/", username: "alice", password: "secret" },
		});
		expect(blocked.status()).toBe(400);
		expect(await blocked.json()).toMatchObject({ code: "WEBDAV_BLOCKED" });

		await page.goto("/drive");
		const dialog = await linkFolder(page, { url: fake.url, username: fake.username, password: "wrong", label });
		await expect(dialog.getByRole("alert")).toContainText("The server refused the username or app password");
		await dialog.getByLabel("App password").fill(fake.password);
		await dialog.getByRole("button", { name: "Link folder" }).click();
		await expect(dialog).toHaveCount(0);
		await expect(row(page, "report.pdf")).toBeVisible();

		fake.setPassword("app-password-2");
		await page.reload();
		const banner = page.getByRole("alert").filter({ hasText: "The server refused the username or app password" });
		await expect(banner).toBeVisible();
		await expect(page.getByRole("link", { name: label })).toContainText(label);
		await expect(page.getByLabel("Needs the app password")).toBeVisible();
		await banner.getByRole("button", { name: "Update app password" }).click();
		const edit = page.getByRole("dialog", { name: "Linked folder" });
		await edit.getByLabel("App password").fill("app-password-2");
		await edit.getByRole("button", { name: "Save" }).click();
		await expect(edit).toHaveCount(0);
		await expect(row(page, "report.pdf")).toBeVisible();
		await expect(banner).toHaveCount(0);
		await expect(page.getByLabel("Needs the app password")).toHaveCount(0);

		// The saved password never goes to a new address or username: it has to be typed again.
		const mountId = decodeURIComponent(new URL(page.url()).pathname.split("/").pop()!);
		const before = fake.requests.length;
		for (const change of [{ url: "https://attacker.example/" }, { username: "mallory" }]) {
			const moved = await account.api.patch(`/api/drive/mounts/${mountId}`, { data: change });
			expect(moved.status(), JSON.stringify(change)).toBe(400);
			expect((await moved.json()).error).toContain("Enter the app password again");
		}
		expect(fake.requests.length).toBe(before);
		await page.getByRole("button", { name: "Linked folder settings" }).click();
		await page.getByRole("menuitem", { name: "Edit link" }).click();
		const relink = page.getByRole("dialog", { name: "Linked folder" });
		const password = relink.getByLabel("App password");
		await expect(password).not.toHaveAttribute("required", "");
		await relink.getByLabel("Username").fill("mallory");
		await expect(password).toHaveAttribute("required", "");
		await expect(relink).toContainText("Enter the app password again");
		await relink.getByRole("button", { name: "Cancel" }).click();
		await expect(relink).toHaveCount(0);

		// At most 20 uploads to linked folders at a time per user.
		const far = Math.floor(Date.now() / 1000) + 3600;
		sql(
			`INSERT INTO drive_mount_uploads (id, owner_id, expires_at) VALUES ${Array.from(
				{ length: 20 },
				(_, index) => `('dmu_e2e_${account.id}_${index}', '${account.id}', ${far})`,
			).join(", ")}`,
		);
		const upload = () =>
			account.api.put(`/api/drive/mounts/${mountId}/content?${new URLSearchParams({ parent: "/", name: "cap.txt" })}`, {
				data: Buffer.from("capped"),
				headers: { "Content-Type": "text/plain" },
			});
		const refused = await upload();
		expect(refused.status()).toBe(429);
		expect(await refused.json()).toMatchObject({ code: "TOO_MANY_UPLOADS" });
		expect(fake.items.has("/cap.txt")).toBe(false);
		sql(`DELETE FROM drive_mount_uploads WHERE owner_id = '${account.id}'`);
		expect((await upload()).status()).toBe(201);
		expect(fake.file("/cap.txt")).toBe("capped");
	} finally {
		await context.close();
		await account.api.dispose();
		await admin.dispose();
		await fake.close();
	}
});

test("on a phone, Link a folder opens above the Drive menu and links the folder", async ({ browser }) => {
	test.setTimeout(90_000);
	const fake = await startFakeWebdav({ files: { "/Scans": null } });
	const admin = await apiContext(STORAGE_STATE);
	const account = await driveAccount(admin, "drvdavph");
	const context = await browser.newContext({
		baseURL: BASE_URL,
		storageState: await account.api.storageState(),
		viewport: { width: 375, height: 812 },
		hasTouch: true,
	});
	const page = await context.newPage();
	await suppressMailboxTour(page);
	const label = `Phone NAS ${uniqueToken("")}`;
	try {
		await page.goto("/drive");
		await page.getByRole("button", { name: "My Drive", exact: true }).click();
		const menu = page.getByRole("dialog", { name: "Drive menu" });
		await expect(menu).toBeVisible();
		const dialog = await linkFolder(page, { url: fake.url, username: fake.username, password: fake.password, label });
		await expect(dialog).toHaveCount(0);
		await expect(page.getByRole("heading", { level: 1, name: label })).toBeVisible();
		await expect(row(page, "Scans")).toBeVisible();
	} finally {
		await context.close();
		await account.api.dispose();
		await admin.dispose();
		await fake.close();
	}
});
