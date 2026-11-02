import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { DOMAIN, STORAGE_STATE, SUPPORT_ADDRESS } from "./support/constants";
import { apiContext, apiSignIn, deliverInbound, uniqueToken } from "./support/helpers";
import { turnScreenerOff } from "./support/screener";

const PASSWORD = "folder-manage-password-123";

type Folder = { id: string; mailboxId: string; name: string; color: string; colorIsCustom: boolean };

async function json<T>(response: Awaited<ReturnType<APIRequestContext["get"]>>): Promise<T> {
	expect(response.ok(), `${response.url()} -> ${response.status()} ${await response.text()}`).toBe(true);
	return (await response.json()) as T;
}

let api: APIRequestContext;
let mailboxId = "";

test.beforeAll(async () => {
	api = await apiContext(STORAGE_STATE);
	const { mailboxes } = await json<{ mailboxes: { id: string; localPart: string; hostname: string }[] }>(
		await api.get("/api/mailboxes"),
	);
	mailboxId = mailboxes.find((mailbox) => `${mailbox.localPart}@${mailbox.hostname}` === SUPPORT_ADDRESS)!.id;
});

test.afterAll(async () => {
	await api.dispose();
});

async function createFolder(name: string, data: { color?: string } = {}): Promise<Folder> {
	return json<Folder>(await api.post("/api/folders", { data: { mailboxId, name, ...data } }));
}

/** Delivers `count` messages to the support mailbox and files them in the folder. */
async function fileMessages(folderId: string, label: string, count: number): Promise<string[]> {
	const ids: string[] = [];
	for (let index = 0; index < count; index++) {
		const stored = await deliverInbound(api, {
			from: `"Folder test" <folders@outside.test>`,
			to: SUPPORT_ADDRESS,
			subject: `${label} ${index}`,
		});
		ids.push(stored.id);
	}
	await json(await api.post("/api/messages/bulk", { data: { action: "folder", folderId, messageIds: ids } }));
	return ids;
}

async function messageState(id: string) {
	const { message } = await json<{ message: { status: string; folderId: string | null } }>(
		await api.get(`/api/messages/${id}`),
	);
	return { status: message.status, folderId: message.folderId };
}

async function folderNames(): Promise<string[]> {
	const { folders } = await json<{ folders: Folder[] }>(await api.get(`/api/folders?mailboxId=${mailboxId}`));
	return folders.map((folder) => folder.name);
}

/** The folder's sidebar row; the folder is the open page, so the sidebar lists it however many folders exist. */
function folderRow(page: Page, id: string) {
	return page.locator(`[data-folder-row="${id}"]`);
}

test("deleting a folder from the sidebar moves its messages to Archive, turns its rule off and leaves the folder page", async ({
	page,
}) => {
	const token = uniqueToken("fd");
	const folder = await createFolder(`Notes ${token}`);
	const ids = await fileMessages(folder.id, `Filed ${token}`, 2);
	const rule = await json<{ id: string }>(
		await api.post("/api/routing-rules", {
			data: { mailboxId, matchValue: `rule-${token}`, destination: `folder:${folder.id}`, priority: 0 },
		}),
	);

	await page.goto(`/folders/${folder.id}`);
	await expect(page.getByRole("main").getByText(`Filed ${token} 0`)).toBeVisible();
	const row = folderRow(page, folder.id);
	await row.hover();
	await row.getByRole("button", { name: `Folder options for Notes ${token}` }).click();
	await page.getByRole("menuitem", { name: "Delete" }).click();

	const dialog = page.getByRole("dialog", { name: `Delete folder Notes ${token}?` });
	await expect(dialog.getByText("2 messages.")).toBeVisible();
	await expect(dialog.getByText("1 inbox rule files mail into this folder; it will be turned off.")).toBeVisible();
	// Archive is the default; Inbox is the other choice.
	await expect(dialog.getByRole("radio", { name: "Move messages to Archive" })).toBeChecked();
	await expect(dialog.getByRole("radio", { name: "Move messages to Inbox" })).not.toBeChecked();
	await dialog.getByRole("button", { name: "Delete folder" }).click();

	await expect(page).toHaveURL(/\/inbox/);
	await expect(folderRow(page, folder.id)).toHaveCount(0);
	for (const id of ids) expect(await messageState(id)).toEqual({ status: "archived", folderId: null });
	expect((await api.get(`/api/folders/${folder.id}`)).status()).toBe(404);
	expect(await folderNames()).not.toContain(`Notes ${token}`);

	const rules = await json<{ rules: { id: string; enabled: boolean }[] }>(
		await api.get(`/api/routing-rules?mailboxId=${mailboxId}`),
	);
	expect(rules.rules.find((item) => item.id === rule.id)?.enabled).toBe(false);
	await api.delete(`/api/routing-rules/${rule.id}?mailboxId=${mailboxId}`);

	await page.goto("/archived");
	await expect(page.getByRole("main").getByText(`Filed ${token} 0`)).toBeVisible();
});

test("deleting a folder can move its messages to the Inbox instead", async ({ page }) => {
	const token = uniqueToken("fi");
	const folder = await createFolder(`Inbox bound ${token}`);
	const [id] = await fileMessages(folder.id, `To inbox ${token}`, 1);

	await page.goto(`/folders/${folder.id}`);
	// The keyboard path: Shift+F10 on the focused row opens the menu like a right-click.
	await folderRow(page, folder.id).getByRole("link").focus();
	await page.keyboard.press("Shift+F10");
	await page.getByRole("menuitem", { name: "Delete" }).click();
	const dialog = page.getByRole("dialog", { name: `Delete folder Inbox bound ${token}?` });
	await dialog.getByRole("radio", { name: "Move messages to Inbox" }).check();
	await dialog.getByRole("button", { name: "Delete folder" }).click();

	await expect(page).toHaveURL(/\/inbox/);
	expect(await messageState(id)).toEqual({ status: "received", folderId: null });
});

test("an empty folder is deleted without choosing where messages go, and another page stays open", async ({ page }) => {
	const token = uniqueToken("fe");
	const folder = await createFolder(`Empty ${token}`);

	await page.goto("/sent");
	const row = folderRow(page, folder.id);
	await row.scrollIntoViewIfNeeded().catch(() => undefined);
	// Not among the first three folders: the other folders list opens with the toggle.
	if ((await row.count()) === 0) await page.getByRole("button", { name: "More..." }).click();
	await row.click({ button: "right" });
	await page.getByRole("menuitem", { name: "Delete" }).click();
	const dialog = page.getByRole("dialog", { name: `Delete folder Empty ${token}?` });
	await expect(dialog.getByText("It holds no messages.")).toBeVisible();
	await expect(dialog.getByRole("radio")).toHaveCount(0);
	await dialog.getByRole("button", { name: "Delete folder" }).click();

	await expect(folderRow(page, folder.id)).toHaveCount(0);
	// Viewing another page, the user stays there.
	await expect(page).toHaveURL(/\/sent/);
});

test("renaming from the context menu updates the sidebar and the folder title; a taken name is refused", async ({
	page,
}) => {
	const token = uniqueToken("fr");
	const folder = await createFolder(`Before ${token}`);
	const other = await createFolder(`Taken ${token}`);

	await page.goto(`/folders/${folder.id}`);
	const row = folderRow(page, folder.id);
	await row.click({ button: "right" });
	await page.getByRole("menuitem", { name: "Rename" }).click();
	const dialog = page.getByRole("dialog", { name: "Rename folder" });
	const input = dialog.getByLabel("Folder name");
	await expect(input).toHaveValue(`Before ${token}`);

	await input.fill(`Taken ${token}`);
	await dialog.getByRole("button", { name: "Rename" }).click();
	await expect(dialog.getByRole("alert")).toHaveText("A folder with that name already exists.");

	await input.fill(`After ${token}`);
	await dialog.getByRole("button", { name: "Rename" }).click();
	await expect(dialog).toBeHidden();
	await expect(row.getByRole("link", { name: new RegExp(`After ${token}`) })).toBeVisible();
	await expect(
		page
			.getByRole("main")
			.getByRole("heading", { name: `After ${token}` })
			.first(),
	).toBeVisible();

	const names = await folderNames();
	expect(names).toContain(`After ${token}`);
	expect(names).not.toContain(`Before ${token}`);
	await api.delete(`/api/folders/${folder.id}`, { data: {} });
	await api.delete(`/api/folders/${other.id}`, { data: {} });
});

test("the API renames and recolours, refuses a duplicate name and a bad request, and keeps the mail when asked to", async () => {
	const token = uniqueToken("fa");
	const folder = await createFolder(`Api ${token}`);
	const other = await createFolder(`Api other ${token}`);

	const renamed = await json<Folder>(
		await api.patch(`/api/folders/${folder.id}`, { data: { name: `  Api renamed ${token} `, color: "#2563eb" } }),
	);
	expect(renamed).toMatchObject({ name: `Api renamed ${token}`, color: "#2563eb", colorIsCustom: true });

	expect((await api.patch(`/api/folders/${folder.id}`, { data: { name: other.name } })).status()).toBe(409);
	// Keeping its own name is not a conflict.
	expect((await api.patch(`/api/folders/${folder.id}`, { data: { name: renamed.name } })).status()).toBe(200);
	expect((await api.patch(`/api/folders/${folder.id}`, { data: {} })).status()).toBe(400);
	expect((await api.patch(`/api/folders/${folder.id}`, { data: { name: "   " } })).status()).toBe(400);
	expect((await api.patch(`/api/folders/${folder.id}`, { data: { color: "#123456" } })).status()).toBe(400);
	expect((await api.patch("/api/folders/fld_missing", { data: { name: "x" } })).status()).toBe(404);

	const [id] = await fileMessages(folder.id, `Api filed ${token}`, 1);
	const usage = await json<{ messageCount: number; ruleCount: number }>(await api.get(`/api/folders/${folder.id}`));
	expect(usage).toMatchObject({ messageCount: 1, ruleCount: 0 });

	// A folder holding mail is never deleted without saying where the mail goes.
	const refused = await api.delete(`/api/folders/${folder.id}`, { data: {} });
	expect(refused.status()).toBe(400);
	expect(((await refused.json()) as { code: string }).code).toBe("FOLDER_MOVE_REQUIRED");
	expect((await api.delete(`/api/folders/${folder.id}`, { data: { moveTo: "trash" } })).status()).toBe(400);
	expect(await messageState(id)).toEqual({ status: "received", folderId: folder.id });

	const deleted = await json<{ messagesMoved: number }>(
		await api.delete(`/api/folders/${folder.id}`, { data: { moveTo: "archive" } }),
	);
	expect(deleted.messagesMoved).toBe(1);
	expect(await messageState(id)).toEqual({ status: "archived", folderId: null });
	expect((await api.delete(`/api/folders/${folder.id}`, { data: {} })).status()).toBe(404);
	await api.delete(`/api/folders/${other.id}`, { data: {} });
});

test("a session mutation from a foreign origin is refused", async () => {
	const folder = await createFolder(`Origin ${uniqueToken("fo")}`);
	const foreign = await apiContext(STORAGE_STATE);
	const headers = { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" };
	expect((await foreign.patch(`/api/folders/${folder.id}`, { data: { name: "Hijacked" }, headers })).status()).toBe(
		403,
	);
	expect((await foreign.delete(`/api/folders/${folder.id}`, { data: {}, headers })).status()).toBe(403);
	await foreign.dispose();
	expect(await folderNames()).toContain(folder.name);
	await api.delete(`/api/folders/${folder.id}`, { data: {} });
});

test("a read-only sharer and an outsider cannot rename or delete a shared mailbox's folder", async () => {
	const token = uniqueToken("fs");
	const { domains } = await json<{ domains: { id: string; hostname: string }[] }>(await api.get("/api/domains"));
	const domainId = domains.find((domain) => domain.hostname === DOMAIN)!.id;

	const accounts: { id: string; address: string }[] = [];
	for (const prefix of ["reader", "outsider"]) {
		const username = `${prefix}${token}`;
		const { account } = await json<{ account: { id: string } }>(
			await api.post("/api/accounts", {
				data: { username, domainId, password: PASSWORD, role: "user", useAllDomains: true },
			}),
		);
		accounts.push({ id: account.id, address: `${username}@${DOMAIN}` });
	}
	const [reader, outsider] = accounts;
	const shared = await json<{ id: string }>(
		await api.post("/api/mailboxes", {
			data: { domainId, localPart: `fold${token}`, displayName: "Folders", type: "shared" },
		}),
	);
	await turnScreenerOff(api, shared.id);
	await json(
		await api.post(`/api/mailboxes/${shared.id}/access`, { data: { userId: reader.id, permission: "read_only" } }),
	);
	const folder = await json<Folder>(
		await api.post("/api/folders", { data: { mailboxId: shared.id, name: `Shared ${token}` } }),
	);

	const readOnly = await apiSignIn(reader.address, PASSWORD);
	expect((await readOnly.get(`/api/folders/${folder.id}`)).status()).toBe(200);
	expect((await readOnly.patch(`/api/folders/${folder.id}`, { data: { name: "Mine now" } })).status()).toBe(403);
	expect((await readOnly.delete(`/api/folders/${folder.id}`, { data: {} })).status()).toBe(403);

	const stranger = await apiSignIn(outsider.address, PASSWORD);
	expect((await stranger.get(`/api/folders/${folder.id}`)).status()).toBe(404);
	expect((await stranger.patch(`/api/folders/${folder.id}`, { data: { name: "Mine now" } })).status()).toBe(404);
	expect((await stranger.delete(`/api/folders/${folder.id}`, { data: {} })).status()).toBe(404);

	const listed = await json<{ folders: Folder[] }>(await api.get(`/api/folders?mailboxId=${shared.id}`));
	expect(listed.folders.map((item) => item.name)).toEqual([`Shared ${token}`]);

	// The owner of the mailbox can, and an anonymous request cannot.
	expect((await api.patch(`/api/folders/${folder.id}`, { data: { name: `Owner ${token}` } })).status()).toBe(200);
	const anonymous = await apiContext();
	expect((await anonymous.delete(`/api/folders/${folder.id}`, { data: {} })).status()).toBe(401);
	await anonymous.dispose();
	expect((await api.delete(`/api/folders/${folder.id}`, { data: {} })).status()).toBe(200);
	await readOnly.dispose();
	await stranger.dispose();
	await api.delete(`/api/mailboxes/${shared.id}`);
});
