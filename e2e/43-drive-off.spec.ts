import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { BASE_URL, STORAGE_STATE, SUPPORT_ADDRESS } from "./support/constants";
import { createLink, createFolder, driveAccount, uploadFile, type DriveAccount } from "./support/drive";
import { apiContext, deliverInbound, openMessage, signIn, uniqueToken } from "./support/helpers";
import { expectNotFoundPage } from "./support/module-flows";
import { restoreModules, setModuleState } from "./support/modules";

const sidebarDrive = (page: Page) => page.getByRole("navigation").first().locator('a[href="/drive"]');

/** Every Drive API method a signed-in caller can reach, with an id that does not exist where one is needed. */
const DRIVE_ROUTES = [
	["GET", "/api/drive/items"],
	["GET", "/api/drive/items/drv_e2e_probe"],
	["PATCH", "/api/drive/items/drv_e2e_probe"],
	["DELETE", "/api/drive/items/drv_e2e_probe"],
	["POST", "/api/drive/items/bulk"],
	["GET", "/api/drive/items/drv_e2e_probe/shares"],
	["GET", "/api/drive/items/drv_e2e_probe/links"],
	["POST", "/api/drive/folders"],
	["POST", "/api/drive/uploads"],
	["PUT", "/api/drive/uploads/drv_e2e_probe/parts/1"],
	["POST", "/api/drive/uploads/drv_e2e_probe/complete"],
	["DELETE", "/api/drive/uploads/drv_e2e_probe"],
	["GET", "/api/drive/files/drv_e2e_probe/content"],
	["GET", "/api/drive/attachments"],
	["GET", "/api/drive/attachments/att_e2e_probe/content"],
	["POST", "/api/drive/attachments/att_e2e_probe/save"],
	["DELETE", "/api/drive/links/dln_e2e_probe"],
] as const;

const DRIVE_ADMIN_ROUTES = [
	["GET", "/api/drive/settings"],
	["GET", "/api/drive/settings/usage"],
] as const;

/**
 * Every route answers `status`; the admin routes answer `adminStatus`, because a member who is not an
 * admin is refused them (403) whether or not Drive is on for them.
 */
async function expectDriveApi(caller: APIRequestContext, status: number, adminStatus = status) {
	const routes = [
		...DRIVE_ROUTES.map(([method, path]) => [method, path, status] as const),
		...DRIVE_ADMIN_ROUTES.map(([method, path]) => [method, path, adminStatus] as const),
	];
	for (const [method, path, expected] of routes) {
		const response = await caller.fetch(path, { method, ...(method === "GET" ? {} : { data: {} }) });
		expect(response.status(), `${method} ${path}`).toBe(expected);
		if (expected === 404) expect(await response.json(), `${method} ${path}`).toEqual({ error: "Not found" });
	}
}

/** A public link to a folder holding one file, made by `owner`, and the file's name. */
async function publicFolder(owner: APIRequestContext) {
	const folder = await createFolder(owner, `Public ${uniqueToken("pub")}`);
	const file = await uploadFile(owner, "notes.txt", "public notes", { parentId: folder.id });
	const { token } = await createLink(owner, folder.id);
	return { folder, file, token };
}

async function expectPublic(visitor: APIRequestContext, token: string, file: string, on: boolean) {
	const metadata = await visitor.get(`/api/public/drive/${token}`);
	expect(metadata.status()).toBe(on ? 200 : 404);
	if (on) expect((await metadata.json()).items.map((item: { name: string }) => item.name)).toEqual(["notes.txt"]);
	const page = await visitor.get(`/d/${token}`);
	expect(page.status(), `/d/${token}`).toBe(on ? 200 : 404);
	const content = await visitor.get(`/api/public/drive/${token}/content?item=${encodeURIComponent(file)}`);
	expect(content.status()).toBe(on ? 200 : 404);
}

/** Opens the delivered message and reports whether its attachment offers Save to Drive. */
async function expectSaveToDrive(page: Page, subject: string, filename: string, offered: boolean) {
	await page.goto("/inbox");
	await openMessage(page, subject);
	await expect(page.getByText(filename, { exact: true }).first()).toBeVisible();
	const trigger = page.getByRole("button", { name: `More actions for ${filename}` });
	if (!offered) return expect(trigger).toHaveCount(0);
	await trigger.click();
	await expect(page.getByRole("dialog", { name: `Actions for ${filename}` }).getByText("Save to Drive")).toBeVisible();
	await page.keyboard.press("Escape");
}

test("Drive off for the install removes nav, pages, API, public links and Save to Drive, and on brings them back unchanged", async ({
	page,
	browser,
}) => {
	test.setTimeout(120_000);
	const api = await apiContext(STORAGE_STATE);
	const anonymous = await apiContext();
	const signedOut = await browser.newContext({ baseURL: BASE_URL, storageState: undefined });
	try {
		const shared = await publicFolder(api);
		const filename = `${uniqueToken("off")}.txt`;
		const subject = `Drive off ${uniqueToken("mail")}`;
		await deliverInbound(api, {
			from: "Files <files@outside.test>",
			to: SUPPORT_ADDRESS,
			subject,
			attachments: [{ filename, contentType: "text/plain", content: "attached text" }],
		});

		await page.goto("/inbox");
		await expect(sidebarDrive(page)).toBeVisible();
		await expectSaveToDrive(page, subject, filename, true);
		await expectPublic(anonymous, shared.token, shared.file.id, true);

		await setModuleState(api, { modules: { drive: false } });
		expect((await (await api.get("/api/auth/me")).json()).modules).not.toContain("drive");
		await page.goto("/inbox");
		await expect(page.getByRole("button", { name: "Compose" })).toBeVisible();
		await expect(sidebarDrive(page)).toHaveCount(0);
		await expectNotFoundPage(page, "/drive");
		await expectNotFoundPage(page, `/drive/f/${shared.folder.id}`);
		await expectNotFoundPage(page, "/drive/settings");
		await expectDriveApi(api, 404);
		await expectDriveApi(anonymous, 404);
		await expectPublic(anonymous, shared.token, shared.file.id, false);
		const visitorPage = await signedOut.newPage();
		expect((await visitorPage.goto(`/d/${shared.token}`))?.status()).toBe(404);
		await expectSaveToDrive(page, subject, filename, false);

		await setModuleState(api, { modules: { drive: true } });
		await page.goto("/drive");
		await expect(page.locator(`[data-drive-item="${shared.folder.name}"]`)).toBeVisible();
		await expectPublic(anonymous, shared.token, shared.file.id, true);
		await expectSaveToDrive(page, subject, filename, true);
		await api.delete(`/api/drive/items/${shared.folder.id}`);
	} finally {
		await restoreModules(api);
		await signedOut.close();
		await anonymous.dispose();
		await api.dispose();
	}
});

test("a user restricted from Drive loses it after authentication, including their public links, while others keep theirs", async ({
	browser,
}) => {
	test.setTimeout(120_000);
	const api = await apiContext(STORAGE_STATE);
	const anonymous = await apiContext();
	const contexts = [await browser.newContext({ baseURL: BASE_URL, storageState: undefined })];
	let restricted: DriveAccount | null = null;
	try {
		restricted = await driveAccount(api, "drvoff");
		const other = await driveAccount(api, "drvon");
		const theirs = await publicFolder(restricted.api);
		const others = await publicFolder(other.api);

		await setModuleState(api, { access: [{ userId: restricted.id, moduleId: "drive", allowed: false }] });
		expect((await (await restricted.api.get("/api/auth/me")).json()).modules).not.toContain("drive");
		expect((await (await other.api.get("/api/auth/me")).json()).modules).toContain("drive");
		await expectDriveApi(restricted.api, 404, 403);
		await expectDriveApi(anonymous, 401);
		expect((await other.api.get("/api/drive/items")).status()).toBe(200);
		await expectPublic(anonymous, theirs.token, theirs.file.id, false);
		await expectPublic(anonymous, others.token, others.file.id, true);

		const page = await contexts[0].newPage();
		await signIn(page, restricted.email, restricted.password);
		await expect(page).toHaveURL(/\/inbox/);
		await expect(sidebarDrive(page)).toHaveCount(0);
		await expectNotFoundPage(page, "/drive");

		await setModuleState(api, { access: [{ userId: restricted.id, moduleId: "drive", allowed: true }] });
		expect((await restricted.api.get("/api/drive/items")).status()).toBe(200);
		await expectPublic(anonymous, theirs.token, theirs.file.id, true);
		await other.api.dispose();
	} finally {
		await restoreModules(api, restricted ? [restricted.id] : []);
		await restricted?.api.dispose();
		await Promise.all(contexts.map((context) => context.close()));
		await anonymous.dispose();
		await api.dispose();
	}
});
