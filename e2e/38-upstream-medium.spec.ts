import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { STORAGE_STATE, SUPPORT_ADDRESS } from "./support/constants";
import { apiContext, deliverInbound, uniqueToken } from "./support/helpers";
import type { StoredMessage } from "./support/helpers-types";

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

type ListRow = StoredMessage & { threadUnread: number; threadMessageIds?: string[] };

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
