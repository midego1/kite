import { expect, test, type APIRequestContext } from "@playwright/test";
import { DOMAIN, STORAGE_STATE } from "./support/constants";
import { apiContext, apiSignIn, deliverInbound, signIn, uniqueToken } from "./support/helpers";

const PASSWORD = "access-control-password-123";

type Mailbox = { id: string; localPart: string; hostname: string; domainId: string };

async function json<T>(response: Awaited<ReturnType<APIRequestContext["get"]>>): Promise<T> {
	expect(response.ok(), `${response.url()} -> ${response.status()} ${await response.text()}`).toBe(true);
	return (await response.json()) as T;
}

async function domainId(api: APIRequestContext): Promise<string> {
	const { domains } = await json<{ domains: { id: string; hostname: string }[] }>(await api.get("/api/domains"));
	const domain = domains.find((item) => item.hostname === DOMAIN);
	expect(domain).toBeDefined();
	return domain!.id;
}

async function ownMailbox(api: APIRequestContext, address: string): Promise<Mailbox> {
	const { mailboxes } = await json<{ mailboxes: Mailbox[] }>(await api.get("/api/mailboxes"));
	const mailbox = mailboxes.find((item) => `${item.localPart}@${item.hostname}` === address);
	expect(mailbox, `mailbox ${address}`).toBeDefined();
	return mailbox!;
}

async function createAccount(admin: APIRequestContext, username: string, domain: string): Promise<string> {
	const response = await admin.post("/api/accounts", {
		data: { username, domainId: domain, password: PASSWORD, role: "user", useAllDomains: true },
	});
	return (await json<{ account: { id: string } }>(response)).account.id;
}

async function createSharedMailbox(admin: APIRequestContext, localPart: string, domain: string): Promise<string> {
	const response = await admin.post("/api/mailboxes", {
		data: { domainId: domain, localPart, displayName: localPart, type: "shared" },
	});
	return (await json<{ id: string }>(response)).id;
}

async function jmap(key: string, methodCalls: unknown[]) {
	const api = await apiContext();
	const response = await api.post("/jmap/api", {
		headers: { Authorization: `Bearer ${key}` },
		data: { using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"], methodCalls },
	});
	const body = await json<{ methodResponses: [string, Record<string, unknown>, string][] }>(response);
	await api.dispose();
	return body.methodResponses.map(([, result]) => result);
}

test("a mailbox owner without mailbox-management rights cannot claim addresses or change domain routing", async ({
	browser,
}) => {
	const token = uniqueToken("ac");
	const username = `owner${token}`;
	const address = `${username}@${DOMAIN}`;
	const admin = await apiContext(STORAGE_STATE);
	const domain = await domainId(admin);
	await createAccount(admin, username, domain);

	const user = await apiSignIn(address, PASSWORD);
	const mailbox = await ownMailbox(user, address);

	await test.step("adding an alias is refused, so a catch-all or shared address cannot be taken over", async () => {
		const response = await user.post(`/api/mailboxes/${mailbox.id}/aliases`, {
			data: { domainId: domain, localPart: `support${token}` },
		});
		expect([403, 404]).toContain(response.status());
	});

	await test.step("domain routing rules cannot be read, created, changed or deleted", async () => {
		const query = new URLSearchParams({ domainId: domain, mailboxId: mailbox.id });
		expect((await user.get(`/api/routing-rules/domain?${query}`)).status()).toBe(403);
		const rule = {
			domainId: domain,
			matchField: "recipient",
			matchOperator: "contains",
			matchValue: "*",
			action: "store",
			mailboxId: mailbox.id,
		};
		expect((await user.post(`/api/routing-rules/domain?${query}`, { data: rule })).status()).toBe(403);

		const created = await json<{ id: string }>(
			await admin.post("/api/routing-rules/domain", {
				data: { ...rule, matchField: "sender", matchValue: `blocked${token}@outside.test`, action: "reject" },
			}),
		);
		expect((await user.patch(`/api/routing-rules/domain/${created.id}`, { data: rule })).status()).toBe(403);
		expect((await user.delete(`/api/routing-rules/domain/${created.id}`)).status()).toBe(403);
		expect((await admin.delete(`/api/routing-rules/domain/${created.id}`)).status()).toBe(200);
	});

	await test.step("Settings > Rules explains that an admin manages domain routing", async () => {
		const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
		const page = await context.newPage();
		await signIn(page, address, PASSWORD);
		await page.goto("/settings/rules");
		await expect(page.getByText("Domain routing is managed by an admin.", { exact: false })).toBeVisible();
		await expect(page.getByRole("button", { name: "Add route" })).toBeDisabled();
		await context.close();
	});

	await user.dispose();
	await admin.dispose();
});

test("an alias cannot take an address that already delivers to another mailbox", async () => {
	const token = uniqueToken("al");
	const admin = await apiContext(STORAGE_STATE);
	const domain = await domainId(admin);
	const shared = `team${token}`;
	await createSharedMailbox(admin, shared, domain);
	const { mailboxes } = await json<{ mailboxes: Mailbox[] }>(await admin.get("/api/mailboxes"));
	const target = mailboxes.find((item) => item.localPart !== shared && item.hostname === DOMAIN)!;
	expect(target).toBeDefined();

	// Inbound mail ignores dots and +tags, so these all reach the shared mailbox already.
	for (const localPart of [shared, `te.am${token}`, `${shared}+x`]) {
		const response = await admin.post(`/api/mailboxes/${target.id}/aliases`, { data: { domainId: domain, localPart } });
		expect(response.status(), localPart).toBe(409);
	}

	const free = await admin.post(`/api/mailboxes/${target.id}/aliases`, {
		data: { domainId: domain, localPart: `free${token}` },
	});
	const { aliases } = await json<{ aliases: { id: string; localPart: string }[] }>(free);
	const alias = aliases.find((item) => item.localPart === `free${token}`)!;
	expect(alias).toBeDefined();
	expect((await admin.delete(`/api/mailboxes/${target.id}/aliases?aliasId=${alias.id}`)).status()).toBe(200);
	await admin.dispose();
});

test("JMAP delegates without full access cannot change, delete or rename shared mail", async () => {
	const token = uniqueToken("jm");
	const admin = await apiContext(STORAGE_STATE);
	const domain = await domainId(admin);
	const username = `mate${token}`;
	const mateId = await createAccount(admin, username, domain);
	const sharedLocalPart = `desk${token}`;
	const sharedId = await createSharedMailbox(admin, sharedLocalPart, domain);
	await json(
		await admin.post(`/api/mailboxes/${sharedId}/access`, { data: { userId: mateId, permission: "send_as" } }),
	);

	const subject = `Delegate ${token}`;
	const stored = await deliverInbound(admin, {
		from: `"Customer" <customer@outside.test>`,
		to: `${sharedLocalPart}@${DOMAIN}`,
		subject,
	});
	const folder = await json<{ id: string }>(
		await admin.post("/api/folders", { data: { mailboxId: sharedId, name: `Folder ${token}` } }),
	);
	await json(
		await admin.post("/api/messages/bulk", {
			data: { action: "folder", folderId: folder.id, messageIds: [stored.id] },
		}),
	);

	const mate = await apiSignIn(`${username}@${DOMAIN}`, PASSWORD);
	const own = await ownMailbox(mate, `${username}@${DOMAIN}`);
	const { key } = await json<{ key: string }>(
		await mate.post("/api/api-keys", {
			data: { name: `jmap ${token}`, scopes: ["jmap"], mailboxIds: [sharedId, own.id] },
		}),
	);
	const accountId = (
		(await (await mate.get("/jmap/session", { headers: { Authorization: `Bearer ${key}` } })).json()) as {
			primaryAccounts: Record<string, string>;
		}
	).primaryAccounts["urn:ietf:params:jmap:mail"];
	expect(accountId).toBeTruthy();

	const sharedFolderRef = `${sharedId}~f~${folder.id}`;
	const [emailSet, rename, crossDestroy] = await jmap(key, [
		["Email/set", { accountId, update: { [stored.id]: { "keywords/$flagged": true } }, destroy: [stored.id] }, "e"],
		["Mailbox/set", { accountId, update: { [sharedFolderRef]: { name: "Renamed" } } }, "r"],
		// A folder id from the shared mailbox paired with the delegate's own mailbox.
		["Mailbox/set", { accountId, destroy: [`${own.id}~f~${folder.id}`], onDestroyRemoveEmails: true }, "d"],
	]);
	expect((emailSet.notUpdated as Record<string, { type: string }>)[stored.id]?.type).toBe("forbidden");
	expect((emailSet.notDestroyed as Record<string, { type: string }>)[stored.id]?.type).toBe("forbidden");
	expect((rename.notUpdated as Record<string, { type: string }>)[sharedFolderRef]?.type).toBe("forbidden");
	expect(crossDestroy.destroyed ?? []).toHaveLength(0);

	const after = await json<{ message: { status: string; folderId: string | null; starred: boolean } }>(
		await admin.get(`/api/messages/${stored.id}`),
	);
	expect(after.message.status).toBe("received");
	expect(after.message.folderId).toBe(folder.id);
	expect(after.message.starred).toBe(false);

	const ownFolder = await json<{ id: string }>(
		await mate.post("/api/folders", { data: { mailboxId: own.id, name: `Own ${token}` } }),
	);
	const ownFolderRef = `${own.id}~f~${ownFolder.id}`;
	const [blank, tooLong, valid] = await jmap(key, [
		["Mailbox/set", { accountId, update: { [ownFolderRef]: { name: "   " } } }, "b"],
		["Mailbox/set", { accountId, update: { [ownFolderRef]: { name: "x".repeat(81) } } }, "l"],
		["Mailbox/set", { accountId, update: { [ownFolderRef]: { name: `Renamed ${token}` } } }, "v"],
	]);
	expect((blank.notUpdated as Record<string, { type: string }>)[ownFolderRef]?.type).toBe("invalidProperties");
	expect((tooLong.notUpdated as Record<string, { type: string }>)[ownFolderRef]?.type).toBe("invalidProperties");
	expect(valid.updated).toHaveProperty([ownFolderRef]);

	await mate.dispose();
	await admin.dispose();
});

test("public booking requests are rate limited per IP", async () => {
	// Runs last in this file: it spends the IP's booking budget for the next minute.
	const api = await apiContext();
	const statuses: number[] = [];
	for (let attempt = 0; attempt < 8; attempt++) {
		const response = await api.post(`/api/public/booking/rate-limit-probe-${uniqueToken("bk")}`, { data: {} });
		statuses.push(response.status());
	}
	// Other specs may have spent part of this minute's budget, so only the shape is fixed.
	expect(statuses.every((status) => status === 404 || status === 429)).toBe(true);
	expect(statuses.at(-1)).toBe(429);
	await api.dispose();
});
