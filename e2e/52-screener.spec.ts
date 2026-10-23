import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import { BASE_URL, DOMAIN, STORAGE_STATE, SUPPORT_ADDRESS } from "./support/constants";
import { okJson, selectMailbox, shareMailbox } from "./support/auto-read";
import { apiContext, apiSignIn, postInbound, uniqueToken, waitForMessage } from "./support/helpers";
import { setScreener } from "./support/screener";

const PASSWORD = "screener-password-123";

type Account = { id: string; api: APIRequestContext; mailboxId: string; address: string };
type MessageRow = { id: string; subject: string | null; status: string; screenerPending?: boolean };
type ScreenerOverview = {
	canManage: boolean;
	settings: { enabled: boolean; mode: string };
	approved: { address: string; source: string }[];
	denied: { address: string }[];
	waiting: number;
};

let admin: APIRequestContext;

test.beforeAll(async () => {
	admin = await apiContext(STORAGE_STATE);
});

test.afterAll(async () => {
	await admin.dispose();
});

/** An account whose personal mailbox keeps the default a new mailbox gets: the Screener on. */
async function screenedAccount(prefix: string): Promise<Account> {
	const username = `${prefix}${uniqueToken("")}`;
	const { domains } = await okJson<{ domains: { id: string; hostname: string }[] }>(await admin.get("/api/domains"));
	const { account } = await okJson<{ account: { id: string } }>(
		await admin.post("/api/accounts", {
			data: {
				username,
				domainId: domains.find((domain) => domain.hostname === DOMAIN)!.id,
				password: PASSWORD,
				role: "user",
				useAllDomains: true,
			},
		}),
	);
	const api = await apiSignIn(`${username}@${DOMAIN}`, PASSWORD);
	const { mailboxes } = await okJson<{ mailboxes: { id: string; localPart: string }[] }>(
		await api.get("/api/mailboxes"),
	);
	return {
		id: account.id,
		api,
		mailboxId: mailboxes.find((item) => item.localPart === username)!.id,
		address: `${username}@${DOMAIN}`,
	};
}

async function overview(api: APIRequestContext, mailboxId: string): Promise<ScreenerOverview> {
	return okJson<ScreenerOverview>(await api.get(`/api/screener?mailboxId=${encodeURIComponent(mailboxId)}`));
}

async function listMessages(api: APIRequestContext, params: Record<string, string>): Promise<MessageRow[]> {
	const response = await api.get(`/api/messages?${new URLSearchParams({ limit: "50", ...params })}`);
	return (await okJson<{ messages: MessageRow[] }>(response)).messages;
}

async function deliverFrom(account: Account, from: string, subject: string, status: string): Promise<MessageRow> {
	await postInbound(account.api, { from, to: account.address, subject, text: `Hello from ${from}` });
	return waitForMessage(account.api, subject, { status });
}

async function messageStatus(api: APIRequestContext, id: string): Promise<string> {
	return (await okJson<{ message: { status: string } }>(await api.get(`/api/messages/${id}`))).message.status;
}

async function openAs(browser: Browser, account: { api: APIRequestContext; id: string }, mailboxId: string) {
	const context = await browser.newContext({ baseURL: BASE_URL, storageState: await account.api.storageState() });
	const page = await context.newPage();
	await selectMailbox(page, mailboxId);
	await page.addInitScript((id) => localStorage.setItem("kite-session-user", id), account.id);
	await page.addInitScript(() => {
		localStorage.setItem("kite-conversation-view", "off");
		localStorage.setItem("kite-reading-pane", "none");
	});
	return { context, page };
}

const screenerLink = (page: Page) => page.locator('[data-reorder-id="/screener"]').getByRole("link");

test("a new mailbox holds mail from a new sender out of the Inbox, search, counts and JMAP", async ({ browser }) => {
	const account = await screenedAccount("scrnew");
	const { mailboxes } = await okJson<{ mailboxes: { id: string; screener: unknown }[] }>(
		await account.api.get("/api/mailboxes"),
	);
	expect(mailboxes.find((item) => item.id === account.mailboxId)?.screener).toEqual({
		enabled: true,
		mode: "screener",
	});

	const subject = uniqueToken("held");
	const held = await deliverFrom(account, "Stranger <stranger@outside.test>", subject, "screening");
	expect(held.screenerPending).toBe(true);
	expect(await listMessages(account.api, { q: subject })).toEqual([]);
	expect(await listMessages(account.api, { direction: "inbound", status: "received", q: subject })).toEqual([]);
	const { counts } = await okJson<{ counts: { folders: Record<string, { total: number; unread: number }> } }>(
		await account.api.get(`/api/messages/counts?mailboxId=${account.mailboxId}`),
	);
	expect(counts.folders.screener).toEqual({ total: 1, unread: 1 });
	expect(counts.folders.inbox.total).toBe(0);

	const { key } = await okJson<{ key: string }>(
		await account.api.post("/api/api-keys", {
			data: { name: `jmap ${subject}`, scopes: ["jmap"], mailboxIds: [account.mailboxId] },
		}),
	);
	const jmap = await apiContext();
	const session = await okJson<{ primaryAccounts: Record<string, string> }>(
		await jmap.get("/jmap/session", { headers: { Authorization: `Bearer ${key}` } }),
	);
	const body = await okJson<{ methodResponses: [string, { ids?: string[] }, string][] }>(
		await jmap.post("/jmap/api", {
			headers: { Authorization: `Bearer ${key}` },
			data: {
				using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
				methodCalls: [["Email/query", { accountId: session.primaryAccounts["urn:ietf:params:jmap:mail"] }, "q"]],
			},
		}),
	);
	expect(body.methodResponses[0][1].ids ?? []).not.toContain(held.id);
	await jmap.dispose();

	const { context, page } = await openAs(browser, account, account.mailboxId);
	try {
		await page.goto("/inbox");
		await expect(screenerLink(page)).toBeVisible();
		await expect(screenerLink(page)).toContainText("1");
		await expect(page.getByText(subject)).toHaveCount(0);
		await screenerLink(page).click();
		await expect(page).toHaveURL(/\/screener$/);
		const row = page.getByRole("listitem").filter({ hasText: subject });
		await expect(row.getByText("New sender")).toBeVisible();
		await expect(row.getByRole("button", { name: "Approve stranger@outside.test" })).toBeVisible();
		await expect(row.getByRole("button", { name: "Deny stranger@outside.test" })).toBeVisible();
	} finally {
		await context.close();
		await account.api.dispose();
	}
});

test("unverified own and system senders still need approval", async () => {
	const account = await screenedAccount("scrspoof");
	try {
		for (const mode of ["screener", "inbox"] as const) {
			await setScreener(account.api, account.mailboxId, { mode });
			for (const from of [
				account.address,
				SUPPORT_ADDRESS,
				"mailer-daemon@outside.test",
				"postmaster@outside.test",
				"mail-daemon@outside.test",
			]) {
				const message = await deliverFrom(
					account,
					from,
					uniqueToken("unverified"),
					mode === "screener" ? "screening" : "received",
				);
				expect(message.screenerPending).toBe(true);
				const status = await okJson<{ pending: boolean }>(
					await account.api.get(`/api/screener/message?messageId=${message.id}`),
				);
				expect(status.pending).toBe(true);
			}
		}
	} finally {
		await account.api.dispose();
	}
});

test("approving releases every held message from the sender, and Undo puts them back", async ({ browser }) => {
	const account = await screenedAccount("scrok");
	const first = await deliverFrom(account, "Pat <pat@outside.test>", uniqueToken("patone"), "screening");
	const second = await deliverFrom(account, "pat@outside.test", uniqueToken("pattwo"), "screening");
	const { context, page } = await openAs(browser, account, account.mailboxId);
	try {
		await page.goto("/screener");
		const row = page.getByRole("listitem").filter({ hasText: first.subject! });
		await row.getByRole("button", { name: "Approve pat@outside.test" }).click();
		const toast = page.getByRole("status").filter({ hasText: "Approved pat@outside.test" });
		await expect(toast).toBeVisible();
		await expect.poll(() => messageStatus(account.api, first.id)).toBe("received");
		expect(await messageStatus(account.api, second.id)).toBe("received");
		await expect(page.getByText(first.subject!)).toHaveCount(0);

		await toast.getByRole("button", { name: "Undo" }).click();
		await expect.poll(() => messageStatus(account.api, first.id)).toBe("screening");
		expect(await messageStatus(account.api, second.id)).toBe("screening");
		expect((await overview(account.api, account.mailboxId)).approved).toEqual([]);

		await okJson(
			await account.api.post("/api/screener/senders", {
				data: { mailboxId: account.mailboxId, address: "PAT@outside.test", decision: "approved" },
			}),
		);
		const later = await deliverFrom(account, "pat@outside.test", uniqueToken("patlater"), "received");
		expect(later.screenerPending).toBeFalsy();
		await page.goto("/inbox");
		await expect(page.getByText(later.subject!)).toBeVisible();
		await expect(page.getByText(first.subject!)).toBeVisible();
	} finally {
		await context.close();
		await account.api.dispose();
	}
});

test("writing to someone approves them, and their reply lands in the Inbox", async () => {
	const account = await screenedAccount("scrsend");
	const recipient = `${uniqueToken("friend")}@outside.test`;
	const sent = await account.api.post("/api/send", {
		data: {
			mailboxId: account.mailboxId,
			from: account.address,
			to: `Friend <${recipient}>`,
			subject: uniqueToken("hello"),
			text: "Hello.",
		},
	});
	expect(sent.ok(), await sent.text()).toBe(true);
	await expect
		.poll(async () => (await overview(account.api, account.mailboxId)).approved.map((entry) => entry.address))
		.toEqual([recipient]);
	expect((await overview(account.api, account.mailboxId)).approved[0].source).toBe("sent");
	await deliverFrom(account, recipient, uniqueToken("reply"), "received");
	await account.api.dispose();
});

test("denying from the reader moves the mail to Spam, blocks the sender and can be undone in Settings", async ({
	browser,
}) => {
	const account = await screenedAccount("scrdeny");
	const sender = `${uniqueToken("pushy")}@outside.test`;
	const held = await deliverFrom(account, `Pushy <${sender}>`, uniqueToken("deny"), "screening");
	const { context, page } = await openAs(browser, account, account.mailboxId);
	try {
		await page.goto(`/screener/${held.id}`);
		const banner = page.getByRole("region", { name: "New sender" });
		await expect(banner).toContainText(sender);
		await banner.getByRole("button", { name: "Deny" }).click();
		const confirm = page.getByRole("alertdialog", { name: `Deny ${sender}?` });
		await expect(confirm).toContainText("move to Spam");
		await confirm.getByRole("button", { name: "Deny" }).click();
		await expect.poll(() => messageStatus(account.api, held.id)).toBe("spam");
		await expect(banner).toHaveCount(0);

		// The block is the one Report phishing adds, a rule that files the sender's mail in Trash.
		const blocked = await deliverFrom(account, sender, uniqueToken("again"), "trash");
		expect(blocked.screenerPending).toBeFalsy();

		await page.goto("/settings/inbox");
		const denied = page.getByRole("region", { name: "Denied senders" });
		await expect(denied).toContainText(sender);
		await denied.getByRole("button", { name: `Un-deny ${sender}` }).click();
		await expect(denied).toContainText("No denied senders.");
		await deliverFrom(account, sender, uniqueToken("undenied"), "screening");
	} finally {
		await context.close();
		await account.api.dispose();
	}
});

test("Inbox mode delivers new senders to the Inbox with a New sender mark and Approve in the row", async ({
	browser,
}) => {
	const account = await screenedAccount("scrmark");
	const { context, page } = await openAs(browser, account, account.mailboxId);
	try {
		await page.goto("/settings/inbox");
		await expect(page.locator("[data-loading-overlay]")).not.toHaveClass(/opacity-100/);
		const inboxMode = page.getByRole("radio", { name: /Deliver to the Inbox/ });
		await inboxMode.click();
		await expect(inboxMode).toBeChecked();
		await expect.poll(async () => (await overview(account.api, account.mailboxId)).settings.mode).toBe("inbox");

		const marked = await deliverFrom(account, "Lee <lee@outside.test>", uniqueToken("mark"), "received");
		expect(marked.screenerPending).toBe(true);
		await page.goto("/inbox");
		await expect(screenerLink(page)).toHaveCount(0);
		const row = page.getByRole("listitem").filter({ hasText: marked.subject! });
		await expect(row.getByText("New sender")).toBeVisible();
		await row.getByRole("button", { name: "Approve lee@outside.test" }).click();
		await expect(row.getByText("New sender")).toHaveCount(0);
		expect((await overview(account.api, account.mailboxId)).approved.map((entry) => entry.address)).toEqual([
			"lee@outside.test",
		]);
	} finally {
		await context.close();
		await account.api.dispose();
	}
});

test("turning the Screener on offers to approve everyone the mailbox has written to", async ({ browser }) => {
	const account = await screenedAccount("scrall");
	await setScreener(account.api, account.mailboxId, { enabled: false });
	const recipient = `${uniqueToken("old")}@outside.test`;
	const sent = await account.api.post("/api/send", {
		data: {
			mailboxId: account.mailboxId,
			from: account.address,
			to: recipient,
			subject: uniqueToken("old"),
			text: "Hi.",
		},
	});
	expect(sent.ok(), await sent.text()).toBe(true);
	await expect
		.poll(async () => (await listMessages(account.api, { status: "sent", mailboxId: account.mailboxId })).length)
		.toBe(1);
	expect((await overview(account.api, account.mailboxId)).approved).toEqual([]);

	const { context, page } = await openAs(browser, account, account.mailboxId);
	try {
		await page.goto("/settings/inbox");
		const toggle = page.getByRole("switch", { name: "Screen new senders" });
		await expect(toggle).toHaveAttribute("aria-checked", "false");
		await toggle.click();
		await page.getByRole("button", { name: "Approve everyone you've written to" }).click();
		await expect(page.getByRole("status").filter({ hasText: "Approved 1 person you have written to" })).toBeVisible();
		await expect(page.getByRole("region", { name: "Approved senders" })).toContainText(recipient);

		// Off means the stored decisions are ignored and nothing is held.
		await toggle.click();
		await expect(toggle).toHaveAttribute("aria-checked", "false");
		await deliverFrom(account, `${uniqueToken("new")}@outside.test`, uniqueToken("off"), "received");
	} finally {
		await context.close();
		await account.api.dispose();
	}
});

test("Screener settings update the sidebar immediately without reloading", async ({ browser }) => {
	const account = await screenedAccount("scrnav");
	const { context, page } = await openAs(browser, account, account.mailboxId);
	try {
		await page.goto("/settings/inbox");
		const toggle = page.getByRole("switch", { name: "Screen new senders" });
		await expect(screenerLink(page)).toBeVisible();
		await toggle.click();
		await expect(toggle).toHaveAttribute("aria-checked", "false");
		await expect(screenerLink(page)).toHaveCount(0);
		await toggle.click();
		await expect(toggle).toHaveAttribute("aria-checked", "true");
		await expect(screenerLink(page)).toBeVisible();
		await page.getByRole("radio", { name: /Deliver to the Inbox/ }).click();
		await expect(screenerLink(page)).toHaveCount(0);
		await page.getByRole("radio", { name: /Hold in the Screener/ }).click();
		await expect(screenerLink(page)).toBeVisible();
	} finally {
		await context.close();
		await account.api.dispose();
	}
});

test("the seeded mailbox keeps the Screener off and shows no Screener link", async ({ page }) => {
	const { mailboxes } = await okJson<{ mailboxes: { localPart: string; hostname: string; screener: unknown }[] }>(
		await admin.get("/api/mailboxes"),
	);
	const support = mailboxes.find((item) => `${item.localPart}@${item.hostname}` === SUPPORT_ADDRESS);
	expect(support?.screener ?? null).toBeNull();
	await page.goto("/inbox");
	await expect(page.locator('[data-reorder-id="/inbox"]')).toBeVisible();
	await expect(screenerLink(page)).toHaveCount(0);
});

test("a read-only member sees held mail and the settings but cannot approve, deny or change them", async ({
	browser,
}) => {
	const token = uniqueToken("scrro");
	const { domains } = await okJson<{ domains: { id: string; hostname: string }[] }>(await admin.get("/api/domains"));
	const { id: sharedId } = await okJson<{ id: string }>(
		await admin.post("/api/mailboxes", {
			data: {
				domainId: domains.find((domain) => domain.hostname === DOMAIN)!.id,
				localPart: `desk${token}`,
				displayName: `Desk ${token}`,
				type: "shared",
			},
		}),
	);
	const member = await screenedAccount("scrmember");
	await shareMailbox(admin, sharedId, member.id, "read_only");
	const shared = { ...member, mailboxId: sharedId, address: `desk${token}@${DOMAIN}` };
	const held = await deliverFrom(shared, "client@outside.test", uniqueToken("desk"), "screening");

	const view = await overview(member.api, sharedId);
	expect(view).toMatchObject({ canManage: false, settings: { enabled: true, mode: "screener" }, waiting: 1 });
	const decide = await member.api.post("/api/screener/senders", {
		data: { mailboxId: sharedId, address: "client@outside.test", decision: "approved" },
	});
	expect(decide.status()).toBe(403);
	expect((await member.api.patch("/api/screener", { data: { mailboxId: sharedId, enabled: false } })).status()).toBe(
		403,
	);
	expect((await member.api.post("/api/screener/approve-sent", { data: { mailboxId: sharedId } })).status()).toBe(403);
	expect(await messageStatus(admin, held.id)).toBe("screening");

	const { context, page } = await openAs(browser, member, sharedId);
	try {
		await page.goto("/screener");
		const row = page.getByRole("listitem").filter({ hasText: held.subject! });
		await expect(row.getByText("New sender")).toBeVisible();
		await expect(row.getByRole("button", { name: /^Approve / })).toHaveCount(0);
		await page.goto(`/screener/${held.id}`);
		const banner = page.getByRole("region", { name: "New sender" });
		await expect(banner).toContainText("Someone with full access");
		await expect(banner.getByRole("button")).toHaveCount(0);
		await page.goto("/settings/inbox");
		await expect(page.getByRole("switch", { name: "Screen new senders" })).toBeDisabled();
		await expect(page.getByText("Full access is required to change the Screener.")).toBeVisible();
	} finally {
		await context.close();
		await member.api.dispose();
	}
});

for (const style of [
	{ name: "Classic", style: "classic", theme: "light" },
	{ name: "dark mode", style: "kite", theme: "dark" },
]) {
	test(`the Screener row controls and reader banner render in ${style.name}`, async ({ browser }) => {
		const account = await screenedAccount("scrlook");
		const held = await deliverFrom(account, "look@outside.test", uniqueToken("look"), "screening");
		const { context, page } = await openAs(browser, account, account.mailboxId);
		try {
			await page.addInitScript(
				({ style: value, theme }) => {
					localStorage.setItem("kite-style", value);
					localStorage.setItem("kite-theme", theme);
				},
				{ style: style.style, theme: style.theme },
			);
			await page.goto("/screener");
			await expect(page.getByRole("listitem").filter({ hasText: held.subject! }).getByText("New sender")).toBeVisible();
			await page.goto(`/screener/${held.id}`);
			await expect(
				page.getByRole("region", { name: "New sender" }).getByRole("button", { name: "Approve" }),
			).toBeVisible();
		} finally {
			await context.close();
			await account.api.dispose();
		}
	});
}
