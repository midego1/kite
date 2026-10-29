import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { DOMAIN, STORAGE_STATE, SUPPORT_ADDRESS } from "./support/constants";
import {
	apiContext,
	apiSignIn,
	deliverInbound,
	setSendingSettings,
	uniqueToken,
	waitForMessage,
} from "./support/helpers";
import { turnScreenerOff } from "./support/screener";

// A message waiting in the outbound queue (the undo delay, a scheduled send) is listed in Sent at once, marked
// "Sending…" or "Scheduled · <time>", and opens with a banner offering Cancel send and Edit (back into the author's
// private Drafts). Once it goes out it is an ordinary Sent email. Teammates see it but cannot take it back.

type Listed = {
	messages: { id: string; subject: string | null; status: string; sendState?: { status: string; own: boolean } }[];
};
type Counts = { counts: { folders: { sent: { total: number } } } };

async function json<T>(response: Awaited<ReturnType<APIRequestContext["get"]>>): Promise<T> {
	expect(response.ok(), `${response.url()} -> ${response.status()} ${await response.text()}`).toBe(true);
	return (await response.json()) as T;
}

/** A mailbox id for the support address, found by delivering a message to it. */
async function supportMailboxId(api: APIRequestContext): Promise<string> {
	const received = await deliverInbound(api, {
		from: `"Sender" <sender@outside.test>`,
		to: SUPPORT_ADDRESS,
		subject: `Queued setup ${uniqueToken()}`,
	});
	return received.mailboxId!;
}

async function sendLater(api: APIRequestContext, mailboxId: string, subject: string, scheduledAt?: Date) {
	const response = await api.post("/api/send", {
		data: {
			from: SUPPORT_ADDRESS,
			to: "customer@outside.test",
			subject,
			text: "Hello from the queue",
			mailboxId,
			...(scheduledAt ? { scheduledAt: scheduledAt.toISOString() } : {}),
		},
	});
	return json<{ messageId: string; scheduled?: boolean; undoUntil?: string }>(response);
}

async function listSent(api: APIRequestContext, subject: string) {
	const params = new URLSearchParams({ direction: "outbound", status: "sent,queued,failed", q: subject });
	return (await json<Listed>(await api.get(`/api/messages?${params}`))).messages;
}

async function sentCount(api: APIRequestContext) {
	return (await json<Counts>(await api.get("/api/messages/counts"))).counts.folders.sent.total;
}

function rowFor(page: Page, subject: string) {
	return page.getByRole("main").locator("[data-message-row]").filter({ hasText: subject }).last();
}

test("a send held by the undo delay shows in Sent as Sending…, can be cancelled and is back in Drafts", async ({
	page,
}) => {
	const api = await apiContext(STORAGE_STATE);
	const mailboxId = await supportMailboxId(api);
	const subject = `Undo hold ${uniqueToken()}`;
	await setSendingSettings(api, { previewEnabled: false, undoSeconds: 30 });
	let sent: Awaited<ReturnType<typeof sendLater>>;
	const before = await sentCount(api);
	try {
		sent = await sendLater(api, mailboxId, subject);
	} finally {
		// Only the send needed the window; do not hold other tests' sends back.
		await setSendingSettings(api, { previewEnabled: false, undoSeconds: 0 });
	}
	expect(sent.undoUntil).toBeTruthy();

	await test.step("it is in Sent at once, marked Sending…, and counted", async () => {
		const listed = await listSent(api, subject);
		expect(listed).toHaveLength(1);
		expect(listed[0]).toMatchObject({ status: "queued", sendState: { status: "queued", own: true } });
		expect(await sentCount(api)).toBe(before + 1);
		await page.goto("/sent");
		const row = rowFor(page, subject);
		await expect(row).toBeVisible({ timeout: 60_000 });
		await expect(row.locator("[data-send-state]")).toHaveText("Sending…");
	});

	await test.step("a plain status=sent list does not include it", async () => {
		const params = new URLSearchParams({ status: "sent", q: subject });
		expect((await json<Listed>(await api.get(`/api/messages?${params}`))).messages).toHaveLength(0);
	});

	await test.step("opening it offers Cancel send, which puts it back in Drafts", async () => {
		await rowFor(page, subject).getByText(subject, { exact: true }).click();
		const banner = page.getByRole("region", { name: "Sending" });
		await expect(banner).toContainText("This message is being sent.");
		await banner.getByRole("button", { name: "Cancel send" }).click();
		await expect(page).toHaveURL(/\/sent$/);
		await expect(page.getByText("Send cancelled. The message is back in Drafts.")).toBeVisible();
		await expect(rowFor(page, subject)).toHaveCount(0);
		await page.goto("/drafts");
		await expect(rowFor(page, subject)).toBeVisible();
	});

	expect(await listSent(api, subject)).toHaveLength(0);
	const drafts = await json<Listed>(
		await api.get(`/api/messages?${new URLSearchParams({ status: "draft", q: subject })}`),
	);
	expect(drafts.messages.map((message) => message.id)).toEqual([sent.messageId]);
	await api.dispose();
});

test("a scheduled send shows its time, cannot be archived or trashed, and Edit opens it as a draft", async ({
	page,
}) => {
	const api = await apiContext(STORAGE_STATE);
	const mailboxId = await supportMailboxId(api);
	const subject = `Scheduled ${uniqueToken()}`;
	const sent = await sendLater(api, mailboxId, subject, new Date(Date.now() + 3_600_000));
	expect(sent.scheduled).toBe(true);

	await page.goto("/sent");
	const row = rowFor(page, subject);
	await expect(row.locator("[data-send-state]")).toContainText(/^Scheduled · /, { timeout: 60_000 });

	await test.step("it cannot be filed away while it waits: the bulk and status APIs answer 409", async () => {
		for (const action of ["archive", "trash", "spam", "phishing", "delete", "inbox"]) {
			const refused = await api.post("/api/messages/bulk", { data: { action, messageIds: [sent.messageId] } });
			expect(refused.status(), action).toBe(409);
			expect(await refused.json()).toMatchObject({ code: "SEND_PENDING_MOVE_REFUSED", sendPendingRefused: 1 });
		}
		const status = await api.post(`/api/messages/${sent.messageId}/status`, { data: { status: "trash" } });
		expect(status.status()).toBe(409);
		expect(await status.json()).toMatchObject({ code: "SEND_PENDING_MOVE_REFUSED" });
		// A mixed selection moves the rest and reports the queued message as left alone, not as handled.
		const other = await deliverInbound(api, {
			from: `"Sender" <sender@outside.test>`,
			to: SUPPORT_ADDRESS,
			subject: `Mixed ${uniqueToken()}`,
		});
		const mixed = await api.post("/api/messages/bulk", {
			data: { action: "archive", messageIds: [sent.messageId, other.id] },
		});
		expect(mixed.ok(), await mixed.text()).toBe(true);
		expect(await mixed.json()).toMatchObject({ ok: true, sendPendingRefused: 1 });
		expect((await listSent(api, subject))[0]).toMatchObject({ status: "queued" });
		// Reading it is not a move.
		const read = await api.post("/api/messages/bulk", { data: { action: "unread", messageIds: [sent.messageId] } });
		expect(read.ok()).toBe(true);
	});

	await test.step("the Sent toolbar offers no archive, spam or delete for it", async () => {
		await rowFor(page, subject).getByRole("checkbox").check();
		await expect(page.getByRole("button", { name: "Archive" }).first()).toBeDisabled();
		await expect(page.getByRole("button", { name: "Report spam" }).first()).toBeDisabled();
		await expect(page.getByRole("button", { name: "Delete", exact: true }).first()).toBeDisabled();
		await rowFor(page, subject).getByRole("checkbox").uncheck();
	});

	await test.step("the reader says when it goes out; Edit moves it to Drafts and opens the composer", async () => {
		await row.getByText(subject, { exact: true }).click();
		const banner = page.getByRole("region", { name: "Scheduled send" });
		await expect(banner).toContainText("This message is scheduled to be sent on");
		await expect(banner.getByRole("button", { name: "Cancel send" })).toBeVisible();
		await banner.getByRole("button", { name: "Edit", exact: true }).click();
		await expect(page).toHaveURL(new RegExp(`/drafts/${sent.messageId}`));
		await expect(page.getByRole("textbox", { name: "Message body" })).toContainText("Hello from the queue");
	});

	expect(await listSent(api, subject)).toHaveLength(0);
	await api.dispose();
});

test("a scheduled send goes out and becomes an ordinary Sent email without the badge", async ({ page }) => {
	const api = await apiContext(STORAGE_STATE);
	const mailboxId = await supportMailboxId(api);
	const subject = `Goes out ${uniqueToken()}`;
	await sendLater(api, mailboxId, subject, new Date(Date.now() + 6_000));

	await page.goto("/sent");
	const row = rowFor(page, subject);
	// Listed from the moment it was scheduled, whether the page was quick enough to see the badge or not.
	await expect(row).toBeVisible({ timeout: 60_000 });

	// The queue delivers it (the test hooks run the Worker's real queue consumer); the status flips to sent.
	await waitForMessage(api, subject, { status: "sent", direction: "outbound" });
	expect((await listSent(api, subject))[0]).toMatchObject({ status: "sent" });
	expect((await listSent(api, subject))[0]!.sendState).toBeUndefined();

	await page.reload();
	await expect(rowFor(page, subject)).toBeVisible({ timeout: 60_000 });
	await expect(rowFor(page, subject).locator("[data-send-state]")).toHaveCount(0);
	await rowFor(page, subject).getByText(subject, { exact: true }).click();
	await expect(page.getByRole("region", { name: /^(Scheduled send|Sending)$/ })).toHaveCount(0);
	await api.dispose();
});

test("a teammate with access sees a queued send in Sent but cannot cancel it", async () => {
	const token = uniqueToken("qs");
	const admin = await apiContext(STORAGE_STATE);
	const { domains } = await json<{ domains: { id: string; hostname: string }[] }>(await admin.get("/api/domains"));
	const domainId = domains.find((domain) => domain.hostname === DOMAIN)!.id;
	const username = `queue${token}`;
	const password = "queued-in-sent-password-123";
	const { account } = await json<{ account: { id: string } }>(
		await admin.post("/api/accounts", { data: { username, domainId, password, role: "user", useAllDomains: true } }),
	);
	const localPart = `desk${token}`;
	const { id: mailboxId } = await json<{ id: string }>(
		await admin.post("/api/mailboxes", { data: { domainId, localPart, displayName: localPart, type: "shared" } }),
	);
	await turnScreenerOff(admin, mailboxId);
	await json(
		await admin.post(`/api/mailboxes/${mailboxId}/access`, { data: { userId: account.id, permission: "full_access" } }),
	);
	const mate = await apiSignIn(`${username}@${DOMAIN}`, password);

	const subject = `Shared schedule ${token}`;
	const response = await admin.post("/api/send", {
		data: {
			from: `${localPart}@${DOMAIN}`,
			to: "customer@outside.test",
			subject,
			text: "Scheduled for later",
			mailboxId,
			scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
		},
	});
	const { messageId } = await json<{ messageId: string }>(response);

	const params = new URLSearchParams({ direction: "outbound", status: "sent,queued,failed", q: subject, mailboxId });
	const seen = (await json<Listed>(await mate.get(`/api/messages?${params}`))).messages;
	expect(seen).toHaveLength(1);
	expect(seen[0]).toMatchObject({ id: messageId, status: "queued", sendState: { status: "queued", own: false } });

	const cancel = await mate.post("/api/send/undo", { data: { messageId } });
	expect(cancel.status()).toBe(404);
	expect((await listSent(admin, subject))[0]).toMatchObject({ status: "queued" });

	// The author takes it back; it is private to them again.
	await json(await admin.post("/api/send/undo", { data: { messageId } }));
	expect((await json<Listed>(await mate.get(`/api/messages?${params}`))).messages).toHaveLength(0);
	const draftParams = new URLSearchParams({ status: "draft", q: subject, mailboxId });
	expect((await json<Listed>(await mate.get(`/api/messages?${draftParams}`))).messages).toHaveLength(0);
	await Promise.all([admin.dispose(), mate.dispose()]);
});
