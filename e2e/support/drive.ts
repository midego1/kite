import { execFileSync } from "node:child_process";
import { expect, type APIRequestContext, type Browser } from "@playwright/test";
import { AUTO_READ_ACCOUNT_PASSWORD, createSignedInAccount, okJson } from "./auto-read";
import { BASE_URL, DOMAIN, E2E_PERSIST_DIR } from "./constants";
import { uniqueToken } from "./helpers";

export type DriveItem = {
	id: string;
	kind: "file" | "folder";
	name: string;
	size: number;
	contentType: string;
	parentId: string | null;
	role: "owner" | "edit" | "view";
	trashedAt: string | null;
};

export type DriveLink = { id: string; url: string | null; active: boolean; hasPassword: boolean };

/** A new account with its own mailbox, signed in on its own API client, for a test that owns its Drive. */
export async function driveAccount(admin: APIRequestContext, prefix: string) {
	const username = `${prefix}${uniqueToken("")}`;
	const account = await createSignedInAccount(admin, username);
	return { ...account, email: `${username}@${DOMAIN}`, password: AUTO_READ_ACCOUNT_PASSWORD };
}

export type DriveAccount = Awaited<ReturnType<typeof driveAccount>>;

/** A browser context signed in as `account` with its API session, so the test spends no extra login. */
export async function signedInPage(browser: Browser, account: DriveAccount) {
	const context = await browser.newContext({ baseURL: BASE_URL, storageState: await account.api.storageState() });
	return { context, page: await context.newPage() };
}

export async function createFolder(api: APIRequestContext, name: string, parentId: string | null = null) {
	return (await okJson<{ item: DriveItem }>(await api.post("/api/drive/folders", { data: { name, parentId } }))).item;
}

/** Uploads through the same session, part and complete calls the browser makes, and returns the stored item. */
export async function uploadFile(
	api: APIRequestContext,
	name: string,
	content: Buffer | string,
	{ contentType = "text/plain", parentId = null }: { contentType?: string; parentId?: string | null } = {},
): Promise<DriveItem> {
	const bytes = typeof content === "string" ? Buffer.from(content) : content;
	const session = await okJson<{ id: string; partSize: number; parts: number; item?: DriveItem }>(
		await api.post("/api/drive/uploads", {
			data: { name, size: bytes.length, contentType, parentId, fingerprint: uniqueToken("fp") },
		}),
	);
	for (let part = 1; part <= session.parts; part += 1) {
		const chunk = bytes.subarray((part - 1) * session.partSize, part * session.partSize);
		const response = await api.put(`/api/drive/uploads/${session.id}/parts/${part}`, {
			data: chunk,
			headers: { "Content-Type": "application/octet-stream" },
		});
		expect(response.status(), await response.text()).toBeLessThan(300);
	}
	return (await okJson<{ item: DriveItem }>(await api.post(`/api/drive/uploads/${session.id}/complete`))).item;
}

export async function listItems(api: APIRequestContext, query = "") {
	return (await okJson<{ items: DriveItem[] }>(await api.get(`/api/drive/items${query ? `?${query}` : ""}`))).items;
}

export async function createLink(
	api: APIRequestContext,
	itemId: string,
	options: { expiresInDays?: number; password?: string } = {},
) {
	const { link } = await okJson<{ link: DriveLink & { url: string } }>(
		await api.post(`/api/drive/items/${itemId}/links`, { data: { expiresInDays: 7, ...options } }),
	);
	return { link, token: new URL(link.url).pathname.split("/").pop()! };
}

export async function shareWith(api: APIRequestContext, itemId: string, email: string, role: "view" | "edit") {
	await okJson(await api.post(`/api/drive/items/${itemId}/shares`, { data: { email, role } }));
}

/** Runs SQL against the e2e database, for states the API cannot reach (a link that has already expired). */
export function sql(command: string) {
	execFileSync(
		"npx",
		["wrangler", "d1", "execute", "DB", "--local", "--persist-to", E2E_PERSIST_DIR, "--command", command],
		{ env: { ...process.env, CI: "1" }, stdio: "pipe" },
	);
}
