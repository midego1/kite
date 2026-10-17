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

const LIST_ACTION_ERROR = "Could not update the messages. Please try again.";

async function deliver(label: string, from = `"Outside Sender" <sender@outside.test>`) {
	const subject = `${label} ${uniqueToken()}`;
	const message = await deliverInbound(api, { from, to: SUPPORT_ADDRESS, subject });
	return { subject, message };
}

/** The list row for a subject; its actions only take pointer events while hovered. */
function messageRow(page: Page, subject: string) {
	return page
		.getByRole("main")
		.locator("div.group")
		.filter({ has: page.getByText(subject, { exact: true }) })
		.last();
}

type MessageState = StoredMessage & { snoozedUntil?: string | null; folderId?: string | null };

async function readMessage(id: string): Promise<MessageState> {
	const response = await api.get(`/api/messages/${id}`);
	expect(response.ok(), await response.text()).toBe(true);
	return ((await response.json()) as { message: MessageState }).message;
}

async function snooze(id: string) {
	const snoozedUntil = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
	const response = await api.post(`/api/messages/${id}/snooze`, { data: { snoozedUntil } });
	expect(response.ok(), await response.text()).toBe(true);
}

async function moveSelectionToInbox(page: Page, subject: string) {
	await messageRow(page, subject).getByRole("checkbox").check();
	await page.getByRole("button", { name: "Move selected messages" }).first().click();
	await page.getByRole("menuitem", { name: "Inbox", exact: true }).click();
}

test("replying to mail sent from the mailbox's own address addresses that sender", async ({ page }) => {
	const { subject, message } = await deliver("Own alias", `"Support Desk" <${SUPPORT_ADDRESS}>`);
	await page.goto(`/inbox/${message.id}`);
	await expect(page.getByRole("heading", { name: subject })).toBeVisible();
	await page
		.getByRole("button", { name: /^Reply( \(r\))?$/ })
		.first()
		.click();

	await expect(page.getByText("Sender address is required")).toHaveCount(0);
	await expect(page.getByLabel("Subject")).toHaveValue(`Re: ${subject}`);
	await expect(page.getByRole("button", { name: new RegExp(`^Remove .*${SUPPORT_ADDRESS}`) })).toBeVisible();
	await expect
		.poll(async () => {
			const params = new URLSearchParams({ status: "draft", q: subject, limit: "5" });
			const data = (await (await api.get(`/api/messages?${params}`)).json()) as {
				messages: { subject: string | null; toAddr: string | null }[];
			};
			return data.messages.find((draft) => draft.subject === `Re: ${subject}`)?.toAddr ?? null;
		})
		.toContain(SUPPORT_ADDRESS);
});

test("Move to Inbox from Snoozed ends the snooze and the message shows in the inbox", async ({ page }) => {
	const { subject, message } = await deliver("Unsnooze by moving");
	await snooze(message.id);
	await page.goto("/snoozed");
	await expect(messageRow(page, subject)).toBeVisible();

	await moveSelectionToInbox(page, subject);
	await expect(page.getByRole("main").getByText(subject, { exact: true })).toHaveCount(0);
	await expect.poll(async () => (await readMessage(message.id)).snoozedUntil ?? null).toBeNull();

	await page.goto("/inbox");
	await expect(messageRow(page, subject)).toBeVisible();
});

test("a custom folder's Move to menu offers Inbox", async ({ page }) => {
	const { subject, message } = await deliver("Back from a folder");
	const created = await api.post("/api/folders", {
		data: { mailboxId: message.mailboxId, name: `Folder ${uniqueToken()}` },
	});
	expect(created.ok(), await created.text()).toBe(true);
	const folder = (await created.json()) as { id: string };
	const moved = await api.post("/api/messages/bulk", {
		data: { action: "folder", folderId: folder.id, messageIds: [message.id] },
	});
	expect(moved.ok(), await moved.text()).toBe(true);

	await page.goto(`/folders/${folder.id}`);
	await expect(messageRow(page, subject)).toBeVisible();
	await moveSelectionToInbox(page, subject);
	await expect.poll(async () => (await readMessage(message.id)).folderId ?? null).toBeNull();
	await page.goto("/inbox");
	await expect(messageRow(page, subject)).toBeVisible();
});

test("a failed list action tells the user instead of failing silently", async ({ page }) => {
	const { subject } = await deliver("Failing action");
	await page.goto("/inbox");
	const row = messageRow(page, subject);
	await expect(row).toBeVisible();
	await page.route("**/api/messages/bulk", (route) =>
		route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"Simulated failure"}' }),
	);

	await row.hover();
	await row.getByRole("button", { name: "Archive" }).click();
	await expect(page.getByText(LIST_ACTION_ERROR)).toBeVisible();
	await expect(row).toBeVisible();

	await row.getByRole("checkbox").check();
	await page.getByRole("button", { name: "Archive", exact: true }).first().click();
	await expect(page.getByText(LIST_ACTION_ERROR)).toBeVisible();

	await page.unroute("**/api/messages/bulk");
	await page.goto("/inbox");
	await expect(messageRow(page, subject)).toBeVisible();
});

test("g then i goes to the inbox, after a stray key and with Shift for g !", async ({ page }) => {
	await page.goto("/starred");
	// The hint appears once the shortcuts preference has loaded, which is when the key bindings attach.
	await expect(page.getByPlaceholder("Search mail (press / to focus)")).toBeVisible();

	await page.keyboard.press("g");
	await page.keyboard.press("i");
	await expect(page).toHaveURL(/\/inbox$/);

	await page.keyboard.press("q");
	await page.keyboard.press("g");
	await page.keyboard.press("t");
	await expect(page).toHaveURL(/\/sent$/);

	await page.keyboard.press("g");
	await page.keyboard.press("Shift+Digit1");
	await expect(page).toHaveURL(/\/spam$/);
});
