import { expect, test, type APIRequestContext } from "@playwright/test";
import { DOMAIN, STORAGE_STATE } from "./support/constants";
import { apiContext, apiSignIn, uniqueToken } from "./support/helpers";
import { turnScreenerOff } from "./support/screener";

// Drafts are private to their author, even in a shared mailbox: a teammate with full access reads the
// mailbox's mail but never another user's draft, by id, in a list, in a count or in search.

const PASSWORD = "draft-privacy-password-123";

type Listed = { messages: { id: string; subject: string | null }[] };
type Counts = { counts: { folders: { drafts: { total: number } } } };

async function json<T>(response: Awaited<ReturnType<APIRequestContext["get"]>>): Promise<T> {
	expect(response.ok(), `${response.url()} -> ${response.status()} ${await response.text()}`).toBe(true);
	return (await response.json()) as T;
}

async function saveDraft(api: APIRequestContext, from: string, mailboxId: string, subject: string, text: string) {
	return (
		await json<{ draft: { id: string } }>(
			await api.post("/api/drafts", { data: { from, mailboxId, to: "customer@outside.test", subject, text } }),
		)
	).draft.id;
}

test("a teammate on a shared mailbox cannot read another user's draft; its author still can", async ({ browser }) => {
	const token = uniqueToken("dp");
	const admin = await apiContext(STORAGE_STATE);
	const { domains } = await json<{ domains: { id: string; hostname: string }[] }>(await admin.get("/api/domains"));
	const domainId = domains.find((domain) => domain.hostname === DOMAIN)!.id;
	const username = `mate${token}`;
	const { account } = await json<{ account: { id: string } }>(
		await admin.post("/api/accounts", {
			data: { username, domainId, password: PASSWORD, role: "user", useAllDomains: true },
		}),
	);
	const localPart = `desk${token}`;
	const address = `${localPart}@${DOMAIN}`;
	const { id: sharedId } = await json<{ id: string }>(
		await admin.post("/api/mailboxes", { data: { domainId, localPart, displayName: localPart, type: "shared" } }),
	);
	await turnScreenerOff(admin, sharedId);
	await json(
		await admin.post(`/api/mailboxes/${sharedId}/access`, { data: { userId: account.id, permission: "full_access" } }),
	);
	const mate = await apiSignIn(`${username}@${DOMAIN}`, PASSWORD);

	const secret = `Secret plan ${token}`;
	const word = `zebra${token}`;
	const draftId = await saveDraft(admin, address, sharedId, secret, `Confidential ${word}`);
	const upload = await admin.post(`/api/drafts/${draftId}/attachments`, {
		multipart: { attachments: { name: "plan.txt", mimeType: "text/plain", buffer: Buffer.from("secret bytes") } },
	});
	const { attachments } = await json<{ attachments: { id: string }[] }>(upload);
	const attachmentId = attachments[0]!.id;
	const mateSubject = `Mate notes ${token}`;
	const mateDraftId = await saveDraft(mate, address, sharedId, mateSubject, "Mate's own words");

	await test.step("the teammate gets 404 for the draft, its attachment and its thread", async () => {
		expect((await mate.get(`/api/messages/${draftId}`)).status()).toBe(404);
		expect((await mate.get(`/api/messages/${draftId}/attachments/${attachmentId}`)).status()).toBe(404);
		expect((await mate.get(`/api/messages/${draftId}/thread`)).status()).toBe(404);
		expect((await mate.post(`/api/messages/${draftId}/star`)).status()).toBe(404);
		const forward = await mate.post("/api/drafts", {
			data: { from: address, mailboxId: sharedId, forwardOfMessageId: draftId },
		});
		expect(forward.status()).toBe(404);
	});

	await test.step("lists, search and counts show the teammate only their own draft", async () => {
		const drafts = await json<Listed>(await mate.get(`/api/messages?mailboxId=${sharedId}&status=draft`));
		expect(drafts.messages.map((row) => row.id)).toEqual([mateDraftId]);
		const search = await json<Listed>(await mate.get(`/api/messages?mailboxId=${sharedId}&q=${word}`));
		expect(search.messages).toHaveLength(0);
		const counts = await json<Counts>(await mate.get(`/api/messages/counts?mailboxId=${sharedId}`));
		expect(counts.counts.folders.drafts.total).toBe(1);
	});

	await test.step("the author still reads, lists, finds and downloads the draft", async () => {
		const own = await json<{ message: { textBody: string } }>(await admin.get(`/api/messages/${draftId}`));
		expect(own.message.textBody).toContain(word);
		const file = await admin.get(`/api/messages/${draftId}/attachments/${attachmentId}`);
		expect(file.status()).toBe(200);
		expect(await file.text()).toBe("secret bytes");
		const drafts = await json<Listed>(await admin.get(`/api/messages?mailboxId=${sharedId}&status=draft`));
		expect(drafts.messages.map((row) => row.id)).toEqual([draftId]);
		const search = await json<Listed>(await admin.get(`/api/messages?mailboxId=${sharedId}&q=${word}`));
		expect(search.messages.map((row) => row.id)).toEqual([draftId]);
		// The mailbox owner is told the same about the teammate's draft.
		expect((await admin.get(`/api/messages/${mateDraftId}`)).status()).toBe(404);
	});

	await test.step("the teammate's Drafts view lists their own draft only", async () => {
		const context = await browser.newContext({ storageState: await mate.storageState() });
		const page = await context.newPage();
		await page.goto("/drafts");
		const switcher = page.getByRole("button", { name: /^Switch mailbox, current:/ });
		// The first visit compiles the dashboard on a cold dev server.
		await expect(switcher).toBeVisible({ timeout: 60_000 });
		await switcher.click();
		await page
			.getByRole("dialog", { name: "Switch mailbox" })
			.getByRole("option", { name: /All mailboxes/ })
			.click();
		const list = page.getByRole("list", { name: "Drafts" });
		await expect(list.getByText(mateSubject)).toBeVisible();
		await expect(page.getByText(secret)).toHaveCount(0);
		await context.close();
	});

	await mate.dispose();
	await admin.dispose();
});
