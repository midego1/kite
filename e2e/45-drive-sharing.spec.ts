import { expect, test, type Page } from "@playwright/test";
import { BASE_URL, STORAGE_STATE } from "./support/constants";
import {
	createFolder,
	createLink,
	driveAccount,
	listItems,
	shareWith,
	sql,
	uploadFile,
	signedInPage,
} from "./support/drive";
import { apiContext } from "./support/helpers";

const row = (page: Page, name: string) => page.locator(`[data-drive-item="${name}"]`);

async function openShareDialog(page: Page, name: string) {
	await page.getByRole("button", { name: `Actions for ${name}` }).click();
	await page.getByRole("menuitem", { name: "Share", exact: true }).click();
	const dialog = page.locator("[data-drive-share]");
	await expect(dialog.getByRole("heading", { name: `Share “${name}”` })).toBeVisible();
	return dialog;
}

test("sharing with people: a viewer reads under Shared with me, an editor changes, and removing a share ends access", async ({
	browser,
}) => {
	test.setTimeout(120_000);
	const admin = await apiContext(STORAGE_STATE);
	const owner = await driveAccount(admin, "drvowner");
	const viewer = await driveAccount(admin, "drvviewer");
	const editor = await driveAccount(admin, "drveditor");
	const ownerSession = await signedInPage(browser, owner);
	const viewerSession = await signedInPage(browser, viewer);
	try {
		const team = await createFolder(owner.api, "Team");
		const plan = await uploadFile(owner.api, "plan.txt", "The plan", { parentId: team.id });

		const page = ownerSession.page;
		await page.goto("/drive");
		const dialog = await openShareDialog(page, "Team");
		await expect(dialog.getByText("Only you have access.")).toBeVisible();
		await dialog.getByLabel("Email address").fill(viewer.email);
		await dialog.getByLabel("Access", { exact: true }).selectOption("view");
		await dialog.getByRole("button", { name: "Share", exact: true }).click();
		await expect(dialog.getByRole("listitem").filter({ hasText: viewer.email })).toContainText("Can view");
		await page.keyboard.press("Escape");
		await expect(row(page, "Team").getByLabel("Shared")).toBeVisible();
		await shareWith(owner.api, team.id, editor.email, "edit");

		const viewerPage = viewerSession.page;
		await viewerPage.goto("/drive/shared");
		await expect(viewerPage.getByRole("heading", { level: 1, name: "Shared with me" })).toBeVisible();
		await row(viewerPage, "Team").getByRole("button", { name: "Team", exact: true }).click();
		await expect(viewerPage.getByRole("heading", { level: 1, name: "Team" })).toBeVisible();
		await expect(row(viewerPage, "plan.txt")).toBeVisible();
		await viewerPage.getByRole("button", { name: "Actions for plan.txt" }).click();
		await expect(viewerPage.getByRole("menuitem", { name: "Download", exact: true })).toBeVisible();
		await expect(viewerPage.getByRole("menuitem", { name: "Rename", exact: true })).toHaveCount(0);
		await viewerPage.keyboard.press("Escape");

		expect(await (await viewer.api.get(`/api/drive/files/${plan.id}/content`)).text()).toBe("The plan");
		expect((await viewer.api.patch(`/api/drive/items/${plan.id}`, { data: { name: "mine.txt" } })).status()).toBe(404);
		const viewerUpload = await viewer.api.post("/api/drive/uploads", {
			data: { name: "x.txt", size: 1, contentType: "text/plain", parentId: team.id, fingerprint: "x" },
		});
		expect(viewerUpload.status()).toBe(404);
		expect((await viewer.api.get(`/api/drive/items/${team.id}/shares`)).status()).toBe(404);

		expect((await editor.api.patch(`/api/drive/items/${plan.id}`, { data: { name: "plan-v2.txt" } })).ok()).toBe(true);
		const added = await uploadFile(editor.api, "notes.txt", "From the editor", { parentId: team.id });
		const names = (await listItems(owner.api, `parent=${team.id}`)).map((item) => item.name).sort();
		expect(names).toEqual(["notes.txt", "plan-v2.txt"]);
		expect((await listItems(owner.api, `parent=${team.id}`)).find((item) => item.id === added.id)?.role).toBe("owner");
		const editShare = await editor.api.post(`/api/drive/items/${team.id}/shares`, {
			data: { email: "admin@example.com", role: "edit" },
		});
		expect(editShare.status()).toBe(403);
		expect((await editShare.json()).error).toBe("Only the owner can give edit access");

		await page.reload();
		const again = await openShareDialog(page, "Team");
		await again.getByRole("button", { name: `Stop sharing with ${viewer.email}` }).click();
		await expect(again.getByRole("listitem").filter({ hasText: viewer.email })).toHaveCount(0);
		await page.keyboard.press("Escape");

		expect((await viewer.api.get(`/api/drive/items/${team.id}`)).status()).toBe(404);
		expect((await viewer.api.get(`/api/drive/files/${plan.id}/content`)).status()).toBe(404);
		await viewerPage.goto("/drive/shared");
		await expect(row(viewerPage, "Team")).toHaveCount(0);
	} finally {
		await ownerSession.context.close();
		await viewerSession.context.close();
		await Promise.all([owner.api.dispose(), viewer.api.dispose(), editor.api.dispose()]);
		await admin.dispose();
	}
});

test("a public file link opens a preview and download for anyone, shows nothing of the owner, and revoking it ends it", async ({
	browser,
}) => {
	test.setTimeout(120_000);
	const admin = await apiContext(STORAGE_STATE);
	const owner = await driveAccount(admin, "drvlink");
	const ownerSession = await signedInPage(browser, owner);
	const visitor = await browser.newContext({ baseURL: BASE_URL, storageState: undefined });
	try {
		await uploadFile(owner.api, "readme.txt", "Read me, anyone");
		const page = ownerSession.page;
		await page.goto("/drive");
		const dialog = await openShareDialog(page, "readme.txt");
		await dialog.getByLabel("Expires after (days)").fill("3");
		await dialog.getByRole("button", { name: "Create link" }).click();
		const active = dialog.locator('[data-drive-link="active"]');
		await expect(active).toContainText("/d/");
		await expect(active).toContainText("0 downloads");
		const url = (await active.locator("span.truncate").first().textContent())!.trim();
		const path = new URL(url).pathname;

		const visit = await visitor.newPage();
		const response = await visit.goto(path);
		expect(response?.status()).toBe(200);
		await expect(visit.getByRole("heading", { level: 1, name: "readme.txt" })).toBeVisible();
		await expect(visit.frameLocator('iframe[title="readme.txt"]').getByText("Read me, anyone")).toBeVisible();
		await expect(visit.locator("body")).not.toContainText(owner.email);
		const download = visit.waitForEvent("download");
		await visit.getByRole("link", { name: "Download" }).first().click();
		expect((await download).suggestedFilename()).toBe("readme.txt");

		await page.reload();
		const again = await openShareDialog(page, "readme.txt");
		await expect(again.locator('[data-drive-link="active"]')).toContainText(/ [1-9]\d* downloads? · last opened /);
		await again.getByRole("button", { name: "Revoke" }).click();
		await expect(again.locator('[data-drive-link="inactive"]')).toContainText("Revoked");

		expect((await visit.goto(path))?.status()).toBe(404);
		const token = path.split("/").pop()!;
		expect((await visitor.request.get(`/api/public/drive/${token}`)).status()).toBe(404);
	} finally {
		await ownerSession.context.close();
		await visitor.close();
		await owner.api.dispose();
		await admin.dispose();
	}
});

test("a password-protected folder link asks for the password, then lists folders first and opens a subfolder", async ({
	browser,
}) => {
	test.setTimeout(120_000);
	const admin = await apiContext(STORAGE_STATE);
	const owner = await driveAccount(admin, "drvpass");
	const visitor = await browser.newContext({ baseURL: BASE_URL, storageState: undefined });
	try {
		const shared = await createFolder(owner.api, "Holiday");
		const sub = await createFolder(owner.api, "Photos", shared.id);
		const file = await uploadFile(owner.api, "a-list.txt", "Packing list", { parentId: shared.id });
		await uploadFile(owner.api, "beach.txt", "Sand", { parentId: sub.id });
		const { token } = await createLink(owner.api, shared.id, { password: "open sesame" });

		expect((await visitor.request.get(`/api/public/drive/${token}`)).status()).toBe(401);
		expect((await visitor.request.get(`/api/public/drive/${token}/content?item=${file.id}`)).status()).toBe(401);

		const page = await visitor.newPage();
		await page.goto(`/d/${token}`);
		await expect(page.getByRole("heading", { name: "This link needs a password" })).toBeVisible();
		await page.getByLabel("Password").fill("wrong");
		await page.getByRole("button", { name: "Open" }).click();
		await expect(page.getByRole("alert")).toHaveText("That password is not right.");
		await page.getByLabel("Password").fill("open sesame");
		await page.getByRole("button", { name: "Open" }).click();

		await expect(page.getByRole("heading", { level: 1, name: "Holiday" })).toBeVisible();
		const listing = page.getByRole("list", { name: "Holiday" });
		await expect(listing.getByRole("listitem")).toHaveText([/Photos/, /a-list\.txt/]);
		await expect(page.getByRole("link", { name: "Download a-list.txt" })).toHaveAttribute("href", /download=1/);
		await listing.getByRole("button", { name: "Photos" }).click();
		await expect(page.getByRole("heading", { level: 1, name: "Photos" })).toBeVisible();
		await expect(page.getByRole("list", { name: "Photos" }).getByRole("listitem")).toHaveText([/beach\.txt/]);
		await page.getByRole("navigation", { name: "Folder path" }).getByRole("button", { name: "Holiday" }).click();
		await expect(page.getByRole("heading", { level: 1, name: "Holiday" })).toBeVisible();

		expect((await visitor.request.get(`/api/public/drive/${token}/content?item=${file.id}`)).status()).toBe(200);
		const outside = await uploadFile(owner.api, "private.txt", "Not shared");
		expect((await visitor.request.get(`/api/public/drive/${token}/content?item=${outside.id}`)).status()).toBe(404);
		expect((await visitor.request.get(`/api/public/drive/${token}?item=${outside.id}`)).status()).toBe(404);
	} finally {
		await visitor.close();
		await owner.api.dispose();
		await admin.dispose();
	}
});

test("an expired link says so, and turning public links off ends every link and the form to make one", async ({
	browser,
}) => {
	test.setTimeout(120_000);
	const admin = await apiContext(STORAGE_STATE);
	const owner = await driveAccount(admin, "drvexpire");
	const ownerSession = await signedInPage(browser, owner);
	const visitor = await browser.newContext({ baseURL: BASE_URL, storageState: undefined });
	const before = (await (await admin.get("/api/drive/settings")).json()).settings;
	try {
		const old = await uploadFile(owner.api, "old.txt", "Old news");
		const current = await uploadFile(owner.api, "current.txt", "Fresh");
		const expired = await createLink(owner.api, old.id);
		const live = await createLink(owner.api, current.id);
		sql(`UPDATE drive_links SET expires_at = unixepoch() - 60 WHERE id = '${expired.link.id}'`);

		const page = await visitor.newPage();
		await page.goto(`/d/${expired.token}`);
		await expect(page.getByRole("heading", { name: "This link has expired" })).toBeVisible();
		await expect(page.locator("body")).not.toContainText("old.txt");
		expect((await visitor.request.get(`/api/public/drive/${expired.token}`)).status()).toBe(404);
		expect((await visitor.request.get(`/api/public/drive/${live.token}`)).status()).toBe(200);

		expect((await admin.patch("/api/drive/settings", { data: { linkMaxDays: 0 } })).ok()).toBe(true);
		expect((await page.goto(`/d/${live.token}`))?.status()).toBe(404);
		expect((await visitor.request.get(`/api/public/drive/${live.token}`)).status()).toBe(404);
		const refused = await owner.api.post(`/api/drive/items/${current.id}/links`, { data: { expiresInDays: 1 } });
		expect(refused.status()).toBe(403);
		expect((await refused.json()).error).toBe("Public links are turned off");
		await ownerSession.page.goto("/drive");
		const dialog = await openShareDialog(ownerSession.page, "current.txt");
		await expect(dialog.getByText("An admin has turned public links off.")).toBeVisible();
		await expect(dialog.getByRole("button", { name: "Create link" })).toHaveCount(0);

		expect((await admin.patch("/api/drive/settings", { data: { linkMaxDays: before.linkMaxDays } })).ok()).toBe(true);
		expect((await visitor.request.get(`/api/public/drive/${live.token}`)).status()).toBe(200);
	} finally {
		await admin.patch("/api/drive/settings", { data: before });
		await ownerSession.context.close();
		await visitor.close();
		await owner.api.dispose();
		await admin.dispose();
	}
});
