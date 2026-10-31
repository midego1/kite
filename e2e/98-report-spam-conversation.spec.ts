import { expect, test, type Page } from "@playwright/test";
import { STORAGE_STATE, SUPPORT_ADDRESS } from "./support/constants";
import { apiContext, deliverInbound, uniqueToken, waitForMessage } from "./support/helpers";

// In conversation view a list shows a thread as one row, so a move from the reader takes what that row stands for
// (the thread within the list's filter): reporting only the open message left the rest of the conversation, and
// its row, in the Inbox. Messages of the thread the row does not show (snoozed, not starred) stay where they are.

/** Two received messages of one conversation: a first message and a reply from the same sender. */
async function deliverConversation(label: string) {
	const api = await apiContext(STORAGE_STATE);
	const token = uniqueToken("conv");
	const subject = `${label} ${token}`;
	const from = `"Conversation Sender" <${token}@outside.test>`;
	const messageId = `<${token}-first@outside.test>`;
	const first = await deliverInbound(api, { from, to: SUPPORT_ADDRESS, subject, text: "First.", messageId });
	const reply = await deliverInbound(api, {
		from,
		to: SUPPORT_ADDRESS,
		subject: `Re: ${subject}`,
		text: "Second.",
		inReplyTo: messageId,
	});
	expect(reply.threadId).toBe(first.threadId);
	return { api, token, subject, first, reply };
}

const inboxRows = (page: Page, token: string) => page.getByRole("main").locator("div.group").filter({ hasText: token });

async function statuses(api: Awaited<ReturnType<typeof apiContext>>, ids: string[]) {
	return Promise.all(
		ids.map(async (id) => {
			const response = await api.get(`/api/messages/${id}`);
			const data = (await response.json()) as { message?: { status: string } };
			return data.message?.status;
		}),
	);
}

async function reportFromReader(page: Page, subject: string, dialogName: string | RegExp = "Report as spam?") {
	await page.getByRole("main").getByText(`Re: ${subject}`, { exact: true }).first().click();
	await expect(page).toHaveURL(/\/inbox\/msg_[\w-]+/);
	await page.getByRole("button", { name: /^Report spam/ }).click();
	await page.getByRole("alertdialog", { name: dialogName }).getByRole("button", { name: "Report spam" }).click();
}

test("Report spam in the reader takes the whole conversation out of the Inbox, and Undo brings it back", async ({
	page,
}) => {
	const { api, token, subject, first, reply } = await deliverConversation("Conversation spam");
	try {
		await page.goto("/inbox");
		await expect(inboxRows(page, token)).toHaveCount(1);
		await reportFromReader(page, subject, "Report 2 messages as spam?");

		await expect.poll(() => statuses(api, [first.id, reply.id])).toEqual(["spam", "spam"]);
		await expect(page).toHaveURL(/\/inbox$/);
		await expect(inboxRows(page, token)).toHaveCount(0);

		const toast = page.getByRole("status").filter({ hasText: "2 messages reported as spam" });
		await expect(toast).toBeVisible();
		await toast.getByRole("button", { name: "Undo" }).click();
		await expect.poll(() => statuses(api, [first.id, reply.id])).toEqual(["received", "received"]);
		await expect(inboxRows(page, token)).toHaveCount(1);
	} finally {
		await api.dispose();
	}
});

test("Archive in the reader archives the whole conversation in conversation view", async ({ page }) => {
	const { api, token, subject, first, reply } = await deliverConversation("Conversation archive");
	try {
		await page.goto("/inbox");
		await page.getByRole("main").getByText(`Re: ${subject}`, { exact: true }).first().click();
		await expect(page).toHaveURL(/\/inbox\/msg_[\w-]+/);
		// The reader's own button (the row's hover Archive already acts on the whole row).
		await page.getByRole("button", { name: "Archive (e)", exact: true }).click();
		await expect.poll(() => statuses(api, [first.id, reply.id])).toEqual(["archived", "archived"]);
		await expect(inboxRows(page, token)).toHaveCount(0);
	} finally {
		await api.dispose();
	}
});

test("with conversation view off, Report spam in the reader reports only the open message", async ({ page }) => {
	await page.addInitScript(() => localStorage.setItem("kite-conversation-view", "off"));
	const { api, token, subject, first, reply } = await deliverConversation("Single spam");
	try {
		await page.goto("/inbox");
		await expect(inboxRows(page, token)).toHaveCount(2);
		await reportFromReader(page, subject);

		await expect.poll(() => statuses(api, [first.id, reply.id])).toEqual(["received", "spam"]);
		await waitForMessage(api, subject, { status: "received" });
		await expect(inboxRows(page, token)).toHaveCount(1);
	} finally {
		await api.dispose();
	}
});

test("in Inbox, a spam report leaves a snoozed message of the conversation alone", async ({ page }) => {
	const { api, token, subject, first, reply } = await deliverConversation("Snoozed sibling");
	try {
		const until = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
		const snoozed = await api.post(`/api/messages/${first.id}/snooze`, { data: { snoozedUntil: until } });
		expect(snoozed.ok()).toBe(true);
		await page.goto("/inbox");
		await expect(inboxRows(page, token)).toHaveCount(1);
		await reportFromReader(page, subject);

		await expect.poll(() => statuses(api, [first.id, reply.id])).toEqual(["received", "spam"]);
		await expect(inboxRows(page, token)).toHaveCount(0);
	} finally {
		await api.dispose();
	}
});

test("in Starred, Archive in the reader leaves the conversation's unstarred messages in the Inbox", async ({
	page,
}) => {
	const { api, token, subject, first, reply } = await deliverConversation("Starred sibling");
	try {
		expect((await api.post(`/api/messages/${reply.id}/star`)).ok()).toBe(true);
		await page.goto("/starred");
		await page.getByRole("main").getByText(`Re: ${subject}`, { exact: true }).first().click();
		await expect(page).toHaveURL(/\/starred\/msg_[\w-]+/);
		await page.getByRole("button", { name: "Archive (e)", exact: true }).click();

		await expect.poll(() => statuses(api, [first.id, reply.id])).toEqual(["received", "archived"]);
		// Starred lists starred mail wherever it is filed, so the archived message stays open there.
		await expect(page.getByRole("heading", { name: `Re: ${subject}` })).toBeVisible();
		await page.goto("/inbox");
		await expect(inboxRows(page, token)).toHaveCount(1);
	} finally {
		await api.dispose();
	}
});
