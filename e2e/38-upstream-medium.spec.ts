import { expect, test, type APIRequestContext, type APIResponse, type Browser, type Page } from "@playwright/test";
import { DOMAIN, STORAGE_STATE, SUPPORT_ADDRESS } from "./support/constants";
import { apiContext, apiSignIn, deliverInbound, signIn, uniqueToken } from "./support/helpers";
import type { StoredMessage } from "./support/helpers-types";
import { useFakeProvider } from "./support/agent";
import { selectMailbox } from "./support/auto-read";
import { askAssistant, chatRequests } from "./support/chat";
import { startFakeModel } from "./support/fake-model";
import type { FakeModel, FakeRecordedRequest } from "./support/fake-model-types";

let api: APIRequestContext;

test.beforeAll(async () => {
	api = await apiContext(STORAGE_STATE);
});

test.afterAll(async () => {
	await api.dispose();
});

const DELETE_SKIPPED = "Some messages could not be deleted because they are no longer in Trash or Spam.";

/** The list row for a subject; its actions only take pointer events while hovered. */
function messageRow(page: Page, subject: string) {
	return page
		.getByRole("main")
		.locator("div.group")
		.filter({ has: page.getByText(subject, { exact: true }) })
		.last();
}

async function bulk(messageIds: string[], action: string) {
	const response = await api.post("/api/messages/bulk", { data: { messageIds, action } });
	expect(response.ok(), await response.text()).toBe(true);
}

async function sidebarInboxCount(page: Page): Promise<number> {
	const text = await page
		.getByRole("navigation")
		.first()
		.getByRole("link", { name: /^Inbox\b/ })
		.innerText();
	return Number(text.match(/\d+/)?.[0] ?? 0);
}

type ListRow = StoredMessage & { threadUnread: number; threadInboundCount: number; threadMessageIds?: string[] };

async function conversationRow(status: string, mailboxId: string, threadId: string): Promise<ListRow | undefined> {
	const params = new URLSearchParams({ status, mailboxId, group: "thread", limit: "100" });
	const response = await api.get(`/api/messages?${params}`);
	expect(response.ok(), await response.text()).toBe(true);
	const data = (await response.json()) as { messages: ListRow[] };
	return data.messages.find((row) => row.threadId === threadId);
}

/** A conversation of three inbound messages, all unread, threaded by In-Reply-To. */
async function deliverConversation(label: string) {
	const subject = `${label} ${uniqueToken()}`;
	const from = `"Outside Sender" <sender@outside.test>`;
	const rootId = `<${uniqueToken("root")}@outside.test>`;
	const first = await deliverInbound(api, { from, to: SUPPORT_ADDRESS, subject, messageId: rootId });
	const second = await deliverInbound(api, {
		from,
		to: SUPPORT_ADDRESS,
		subject: `Re: ${subject} second`,
		inReplyTo: rootId,
	});
	const third = await deliverInbound(api, {
		from,
		to: SUPPORT_ADDRESS,
		subject: `Re: ${subject} third`,
		inReplyTo: rootId,
	});
	expect(second.threadId).toBe(first.threadId);
	expect(third.threadId).toBe(first.threadId);
	return { subject, first, second, third, threadId: first.threadId! };
}

test.describe("conversation unread state and skipped deletes (upstream #135)", () => {
	test("a conversation row is unread only for unread mail in the folder it is listed in", async ({ page }) => {
		const { subject, first, threadId } = await deliverConversation("Folder unread");
		await bulk([first.id], "archive");
		await bulk([first.id], "read");

		const inbox = await conversationRow("received", first.mailboxId, threadId);
		expect(inbox?.threadUnread).toBe(2);
		expect(inbox?.threadMessageIds).toHaveLength(2);
		const archived = await conversationRow("archived", first.mailboxId, threadId);
		expect(archived?.threadUnread).toBe(0);

		await page.goto("/archived");
		const row = messageRow(page, subject);
		await expect(row).toBeVisible();
		await expect(row.locator(".font-bold")).toHaveCount(0);
	});

	test("marking a conversation read or unread moves the sidebar Inbox count by its unread messages", async ({
		page,
	}) => {
		const { second } = await deliverConversation("Sidebar count");
		await page.goto("/inbox");
		const row = messageRow(page, second.subject!.replace(/ second$/, " third"));
		await expect(row).toBeVisible();
		await expect.poll(() => sidebarInboxCount(page)).toBeGreaterThanOrEqual(3);
		const before = await sidebarInboxCount(page);

		await row.hover();
		await row.getByRole("button", { name: "Mark as read" }).click();
		await expect.poll(() => sidebarInboxCount(page)).toBe(before - 3);

		await row.hover();
		await row.getByRole("button", { name: "Mark as unread" }).click();
		await expect.poll(() => sidebarInboxCount(page)).toBe(before);
	});

	test("opening an unread message outside the Inbox leaves the sidebar Inbox count alone", async ({ page }) => {
		const subject = `Archived unread ${uniqueToken()}`;
		const message = await deliverInbound(api, { from: "sender@outside.test", to: SUPPORT_ADDRESS, subject });
		await bulk([message.id], "archive");
		await bulk([message.id], "unread");
		// An unread Inbox message, so the sidebar count is known to have loaded once it is above zero.
		await deliverInbound(api, {
			from: "sender@outside.test",
			to: SUPPORT_ADDRESS,
			subject: `Inbox unread ${uniqueToken()}`,
		});

		await page.goto("/archived");
		await expect.poll(() => sidebarInboxCount(page)).toBeGreaterThan(0);
		const before = await sidebarInboxCount(page);
		await messageRow(page, subject).getByText(subject, { exact: true }).click();
		await expect(page).toHaveURL(new RegExp(`/archived/${message.id}`));
		await expect(page.getByRole("heading", { name: subject })).toBeVisible();
		expect(await sidebarInboxCount(page)).toBe(before);
	});

	test("marking a Sent conversation unread never gives it optimistic unread styling", async ({ page }) => {
		const { messages } = await json<{ messages: ListRow[] }>(
			await api.get("/api/messages?status=sent&direction=outbound&group=thread"),
		);
		const sent = messages[0];
		expect(sent.threadInboundCount).toBe(0);
		await bulk(sent.threadMessageIds!, "read");
		await selectMailbox(page, sent.mailboxId);
		await page.goto("/sent");
		const row = messageRow(page, sent.subject!);
		await expect(row).toBeVisible();
		await row.getByRole("checkbox").check();

		let release!: () => void;
		const held = new Promise<void>((resolve) => (release = resolve));
		await page.route("**/api/messages/bulk", async (route) => {
			await held;
			await route.continue();
		});
		try {
			const request = page.waitForRequest("**/api/messages/bulk");
			await page.getByRole("button", { name: "Mark as unread", exact: true }).first().click();
			await request;
			await expect(row.locator(".font-bold")).toHaveCount(0);
			const response = page.waitForResponse("**/api/messages/bulk");
			release();
			expect((await response).ok()).toBe(true);
			await expect(row.locator(".font-bold")).toHaveCount(0);
		} finally {
			release();
		}
	});

	test("deleting forever a message that left Trash keeps the page open and says why", async ({ page }) => {
		const subject = `Skipped single ${uniqueToken()}`;
		const message = await deliverInbound(api, { from: "sender@outside.test", to: SUPPORT_ADDRESS, subject });
		await bulk([message.id], "trash");

		await page.goto(`/trash/${message.id}`);
		await expect(page.getByRole("heading", { name: subject })).toBeVisible();
		await bulk([message.id], "archive");

		await page.getByRole("button", { name: "Delete forever" }).first().click();
		await page
			.getByRole("alertdialog", { name: "Delete forever?" })
			.getByRole("button", { name: "Delete forever" })
			.click();
		await expect(page.getByText(DELETE_SKIPPED)).toBeVisible();
		await expect(page).toHaveURL(new RegExp(`/trash/${message.id}`));
		expect((await api.get(`/api/messages/${message.id}`)).status()).toBe(200);
	});

	test("deleting a selection forever reports the messages that had left Trash", async ({ page }) => {
		const token = uniqueToken();
		const kept = await deliverInbound(api, {
			from: "sender@outside.test",
			to: SUPPORT_ADDRESS,
			subject: `Skipped kept ${token}`,
		});
		const gone = await deliverInbound(api, {
			from: "sender@outside.test",
			to: SUPPORT_ADDRESS,
			subject: `Skipped gone ${token}`,
		});
		await bulk([kept.id, gone.id], "trash");

		await page.addInitScript(() => localStorage.setItem("kite-conversation-view", "off"));
		await page.goto("/trash");
		await messageRow(page, kept.subject!).getByRole("checkbox").check();
		await messageRow(page, gone.subject!).getByRole("checkbox").check();
		await bulk([kept.id], "archive");

		await page.getByRole("button", { name: "Delete forever" }).first().click();
		await page
			.getByRole("alertdialog", { name: "Delete forever?" })
			.getByRole("button", { name: "Delete forever" })
			.click();
		await expect(page.getByText(`1 message deleted forever. ${DELETE_SKIPPED}`)).toBeVisible();
		await expect.poll(async () => (await api.get(`/api/messages/${gone.id}`)).status()).toBe(404);
		expect((await api.get(`/api/messages/${kept.id}`)).status()).toBe(200);
	});
});

const MEMBER_PASSWORD = "upstream-medium-password-123";

async function json<T>(response: APIResponse): Promise<T> {
	expect(response.ok(), `${response.url()} -> ${response.status()} ${await response.text()}`).toBe(true);
	return (await response.json()) as T;
}

/** A member account on the demo domain, optionally granted mailbox management. */
async function createMember(username: string, canManageMailboxes: boolean) {
	const { domains } = await json<{ domains: { id: string; hostname: string }[] }>(await api.get("/api/domains"));
	const domainId = domains.find((domain) => domain.hostname === DOMAIN)!.id;
	const { account } = await json<{ account: { id: string } }>(
		await api.post("/api/accounts", {
			data: { username, domainId, password: MEMBER_PASSWORD, role: "user", useAllDomains: true },
		}),
	);
	await json(
		await api.patch(`/api/accounts/${account.id}`, {
			data: { name: username, role: "user", disabled: false, canManageMailboxes, canManageDomains: false },
		}),
	);
	return { id: account.id, address: `${username}@${DOMAIN}` };
}

async function memberPage(browser: Browser, address: string) {
	const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
	const page = await context.newPage();
	await signIn(page, address, MEMBER_PASSWORD);
	await expect(page).not.toHaveURL(/\/login/);
	return { context, page };
}

function settingsNav(page: Page) {
	return page.getByRole("navigation", { name: "Mailbox" });
}

test.describe("Settings → Mailboxes (upstream #133)", () => {
	test("Settings offers only the current mailbox owner while Admin offers other accounts", async ({ page }) => {
		const username = `mbowner${uniqueToken("m").toLowerCase()}`.replace(/[^a-z0-9]/g, "");
		const member = await createMember(username, true);
		const { user } = await json<{ user: { id: string } }>(await api.get("/api/auth/me"));

		await page.goto("/settings/mailboxes");
		await page.getByRole("button", { name: "New mailbox" }).click();
		const owner = page.getByLabel("Account", { exact: true });
		await expect(owner).toHaveValue(user.id);
		await expect(owner.locator("option")).toHaveCount(1);
		await expect(owner.locator("option")).toHaveAttribute("value", user.id);

		await page.goto("/mailboxes");
		await page.getByRole("button", { name: "New mailbox" }).click();
		await expect(owner.locator(`option[value="${member.id}"]`)).toHaveCount(1);
		await owner.selectOption(member.id);
		await expect(owner).toHaveValue(member.id);
	});

	test("a member with the mailbox grant renames their own mailbox from Settings", async ({ browser }) => {
		const username = `mbset${uniqueToken("m").toLowerCase()}`.replace(/[^a-z0-9]/g, "");
		const member = await createMember(username, true);
		const { context, page } = await memberPage(browser, member.address);
		try {
			await page.goto("/settings/account");
			await settingsNav(page).getByRole("link", { name: "Mailboxes" }).click();
			await expect(page).toHaveURL(/\/settings\/mailboxes$/);
			await expect(page.getByRole("heading", { name: "Mailboxes", level: 1 })).toBeVisible();
			const row = page.getByRole("link", { name: new RegExp(member.address) });
			await expect(row).toBeVisible();
			await expect(page.getByText(SUPPORT_ADDRESS, { exact: true })).toHaveCount(0);

			await row.click();
			await expect(page).toHaveURL(/\/settings\/mailboxes\/mbx_[\w-]+$/);
			await expect(page.getByText(member.address, { exact: true })).toBeVisible();
			const name = page.getByLabel("Name", { exact: true });
			await expect(name).toBeEnabled();
			await name.fill(`Renamed ${username}`);
			await page.getByRole("button", { name: "Save changes" }).click();
			await expect(page.getByText("Mailbox settings saved")).toBeVisible();
			await expect(page).toHaveURL(/\/settings\/mailboxes\//);
		} finally {
			await context.close();
		}
	});

	test("a member without the grant gets no Mailboxes entry and is sent back from the page", async ({ browser }) => {
		const username = `mbnone${uniqueToken("m").toLowerCase()}`.replace(/[^a-z0-9]/g, "");
		const member = await createMember(username, false);
		const { context, page } = await memberPage(browser, member.address);
		try {
			await page.goto("/settings/account");
			await expect(settingsNav(page).getByRole("link", { name: "Export" })).toBeVisible();
			await expect(settingsNav(page).getByRole("link", { name: "Mailboxes" })).toHaveCount(0);
			await page.goto("/settings/mailboxes");
			await expect(page).toHaveURL(/\/settings\/account$/);
			await expect(page.getByRole("button", { name: "New mailbox" })).toHaveCount(0);
		} finally {
			await context.close();
		}
	});

	test("the API refuses a member's change to a mailbox they do not own", async () => {
		const username = `mbapi${uniqueToken("m").toLowerCase()}`.replace(/[^a-z0-9]/g, "");
		const member = await createMember(username, true);
		const memberApi = await apiSignIn(member.address, MEMBER_PASSWORD);
		try {
			const { mailboxes } = await json<{ mailboxes: { id: string; localPart: string; hostname: string }[] }>(
				await api.get("/api/mailboxes"),
			);
			const support = mailboxes.find((mailbox) => `${mailbox.localPart}@${mailbox.hostname}` === SUPPORT_ADDRESS);
			expect(support).toBeDefined();
			expect((await memberApi.get(`/api/mailboxes/${support!.id}`)).status()).toBe(404);
			expect(
				(await memberApi.patch(`/api/mailboxes/${support!.id}`, { data: { displayName: "Taken" } })).status(),
			).toBe(404);
			expect((await memberApi.delete(`/api/mailboxes/${support!.id}`)).status()).toBe(403);
		} finally {
			await memberApi.dispose();
		}
	});
});

/** The text of the newest user turn in a chat request the fake model received. */
function latestUserTurn(request: FakeRecordedRequest): string {
	const messages = (request.body as { messages?: { role?: string; content?: unknown }[] }).messages ?? [];
	const content = messages.filter((message) => message.role === "user").at(-1)?.content;
	return typeof content === "string" ? content : JSON.stringify(content ?? "");
}

async function lastAssistantRequest(fake: FakeModel) {
	await expect.poll(() => chatRequests(fake).filter((request) => request.kind === "other").length).toBeGreaterThan(0);
	return chatRequests(fake)
		.filter((request) => request.kind === "other")
		.at(-1)!;
}

async function openEmailAssistant(page: Page, message: StoredMessage, waitForMessage = true) {
	await selectMailbox(page, message.mailboxId);
	await page.addInitScript(() => localStorage.setItem("kite-assistant-layout", "floating"));
	await page.goto(`/inbox/${message.id}`);
	if (waitForMessage) await expect(page.getByRole("heading", { name: message.subject! })).toBeVisible();
	const toggle = page.getByRole("button", { name: /^(Open|Close) email assistant$/ });
	if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
	return page.getByRole("region", { name: "Email assistant" });
}

test.describe("the assistant knows which email is open (upstream #140)", () => {
	let fake: FakeModel | undefined;
	let restore: (() => Promise<void>) | undefined;

	test.beforeAll(async () => {
		fake = await startFakeModel();
		restore = await useFakeProvider(api, fake);
	});

	test.afterAll(async () => {
		await restore?.();
		await fake?.close();
	});

	test("the open email shows above the prompt, reaches the model by ID and can be removed", async ({ page }) => {
		const subject = `Open email ${uniqueToken()}`;
		const message = await deliverInbound(api, { from: "sender@outside.test", to: SUPPORT_ADDRESS, subject });
		const panel = await openEmailAssistant(page, message);
		const chip = panel.getByText(`Current email: ${subject}`, { exact: true });
		await expect(chip).toBeVisible();
		await expect(panel.getByText("Current thread", { exact: true })).toBeVisible();

		fake!.clearRequests();
		fake!.scriptChat({ content: "It is a routine message." });
		await askAssistant(page, "What is this about?");
		await expect(panel.getByText("It is a routine message.", { exact: true })).toBeVisible();
		const withEmail = latestUserTurn(await lastAssistantRequest(fake!));
		expect(withEmail).toContain("What is this about?");
		expect(withEmail).toContain(`The user now has email ${message.id} open`);
		expect(withEmail).not.toContain(subject);

		await panel.getByRole("button", { name: "Don’t use this email" }).click();
		await expect(chip).toHaveCount(0);
		await expect(panel.getByText("Your mailbox", { exact: true })).toBeVisible();
		fake!.clearRequests();
		fake!.scriptChat({ content: "Here is your mailbox." });
		await askAssistant(page, "What else arrived?");
		await expect(panel.getByText("Here is your mailbox.", { exact: true })).toBeVisible();
		expect(latestUserTurn(await lastAssistantRequest(fake!))).toBe("What else arrived?");
	});

	test("opening another email ends dismissal when returning to the original email", async ({ page }) => {
		const first = await deliverInbound(api, {
			from: "sender@outside.test",
			to: SUPPORT_ADDRESS,
			subject: `Dismissed email ${uniqueToken()}`,
		});
		const second = await deliverInbound(api, {
			from: "sender@outside.test",
			to: SUPPORT_ADDRESS,
			subject: `Other email ${uniqueToken()}`,
		});
		const panel = await openEmailAssistant(page, first);
		await panel.getByRole("button", { name: "Don’t use this email" }).click();
		await expect(panel.getByText(`Current email: ${first.subject}`, { exact: true })).toHaveCount(0);
		await messageRow(page, second.subject!).getByText(second.subject!, { exact: true }).click();
		await expect(panel.getByText(`Current email: ${second.subject}`, { exact: true })).toBeVisible();
		await messageRow(page, first.subject!).getByText(first.subject!, { exact: true }).click();
		await expect(panel.getByText(`Current email: ${first.subject}`, { exact: true })).toBeVisible();

		fake!.clearRequests();
		fake!.scriptChat({ content: "The original email is open again." });
		await askAssistant(page, "Which email is open?");
		expect(latestUserTurn(await lastAssistantRequest(fake!))).toContain(`The user now has email ${first.id} open`);
	});

	test("chat sends the open email ID while its subject is still loading", async ({ page }) => {
		const message = await deliverInbound(api, {
			from: "sender@outside.test",
			to: SUPPORT_ADDRESS,
			subject: `Slow subject ${uniqueToken()}`,
		});
		let release!: () => void;
		const held = new Promise<void>((resolve) => (release = resolve));
		await page.route(`**/api/messages/${message.id}`, async (route) => {
			await held;
			await route.continue();
		});
		try {
			const panel = await openEmailAssistant(page, message, false);
			await expect(panel.getByText(`Current email: ${message.subject}`, { exact: true })).toHaveCount(0);
			fake!.clearRequests();
			fake!.scriptChat({ content: "The selected email is included." });
			await askAssistant(page, "Summarize the selected email");
			expect(latestUserTurn(await lastAssistantRequest(fake!))).toContain(`The user now has email ${message.id} open`);
			release();
			await expect(panel.getByText(`Current email: ${message.subject}`, { exact: true })).toBeVisible();
		} finally {
			release();
		}
	});

	test("the chat API ignores an open email from another mailbox", async () => {
		const message = await deliverInbound(api, {
			from: "sender@outside.test",
			to: SUPPORT_ADDRESS,
			subject: `Foreign email ${uniqueToken()}`,
		});
		const { mailboxes } = await json<{ mailboxes: { id: string }[] }>(await api.get("/api/mailboxes"));
		const other = mailboxes.find((mailbox) => mailbox.id !== message.mailboxId);
		expect(other).toBeDefined();

		fake!.clearRequests();
		fake!.scriptChat({ content: "Nothing open." });
		const response = await api.post("/api/agent/chat", {
			data: { mailboxId: other!.id, text: "Summarize this email", currentMessageId: message.id },
		});
		expect(response.ok(), await response.text()).toBe(true);
		expect(latestUserTurn(await lastAssistantRequest(fake!))).toBe("Summarize this email");
	});
});
