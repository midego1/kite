import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import { DOMAIN, STORAGE_STATE } from "./support/constants";
import { apiContext, apiSignIn, deliverInbound, setSendingSettings, uniqueToken } from "./support/helpers";
import { turnScreenerOff } from "./support/screener";
import { expectSelectValue } from "./support/select";

// The All mailboxes view: one account with two mailboxes of its own and read-only access to a shared one
// reads them in one Inbox, filters them, answers from the right address and cannot move the shared mail.

const PASSWORD = "all-mailboxes-password-123";

type Mailbox = { id: string; localPart: string; hostname: string };
type Box = { id: string; address: string; name: string };
type ListedMessage = { id: string; subject: string | null; status: string; fromAddr: string; mailboxId: string };

test.describe.configure({ mode: "serial" });

let user: APIRequestContext;
let storageState: Awaited<ReturnType<APIRequestContext["storageState"]>>;
let home: Box;
let work: Box;
let desk: Box;
let token: string;

async function json<T>(response: Awaited<ReturnType<APIRequestContext["get"]>>): Promise<T> {
	expect(response.ok(), `${response.url()} -> ${response.status()} ${await response.text()}`).toBe(true);
	return (await response.json()) as T;
}

/** Delivered through the real email handler and awaited as the account itself, which can read all three. */
async function deliver(box: Box, subject: string) {
	await deliverInbound(user, { from: `"Outside Sender" <sender@outside.test>`, to: box.address, subject });
}

async function listMessages(query: string): Promise<ListedMessage[]> {
	return (await json<{ messages: ListedMessage[] }>(await user.get(`/api/messages?${query}`))).messages;
}

async function openPage(browser: Browser, viewport?: { width: number; height: number }): Promise<Page> {
	const context = await browser.newContext({ storageState, ...(viewport ? { viewport, hasTouch: true } : {}) });
	return context.newPage();
}

function inboxList(page: Page) {
	return page.getByRole("list", { name: "Inbox" });
}

function row(page: Page, subject: string) {
	return inboxList(page)
		.locator("[data-message-row]")
		.filter({ has: page.getByText(subject, { exact: true }) });
}

async function openSwitcher(page: Page) {
	const trigger = page.getByRole("button", { name: /^Switch mailbox, current:/ });
	// The first visit compiles the dashboard on a cold dev server.
	await expect(trigger).toBeVisible({ timeout: 60_000 });
	await trigger.click();
	return page.getByRole("listbox", { name: "Mailboxes" });
}

async function showAllMailboxes(page: Page) {
	await page.goto("/inbox");
	const switcher = await openSwitcher(page);
	await switcher.getByRole("option", { name: /All mailboxes/ }).click();
	await expect(page.getByRole("button", { name: "Switch mailbox, current: All mailboxes" })).toBeVisible();
}

test.beforeAll(async () => {
	token = uniqueToken("um");
	const admin = await apiContext(STORAGE_STATE);
	const { domains } = await json<{ domains: { id: string; hostname: string }[] }>(await admin.get("/api/domains"));
	const domainId = domains.find((domain) => domain.hostname === DOMAIN)!.id;
	const username = `all${token}`;
	const { account } = await json<{ account: { id: string } }>(
		await admin.post("/api/accounts", {
			data: { username, domainId, password: PASSWORD, role: "user", useAllDomains: false },
		}),
	);
	await json(
		await admin.post("/api/mailboxes", {
			data: { domainId, localPart: `work${token}`, displayName: "Work desk", ownerUserId: account.id },
		}),
	);
	const shared = await json<{ id: string }>(
		await admin.post("/api/mailboxes", {
			data: { domainId, localPart: `desk${token}`, displayName: "Help desk", type: "shared" },
		}),
	);
	await turnScreenerOff(admin, shared.id);
	await json(
		await admin.post(`/api/mailboxes/${shared.id}/access`, { data: { userId: account.id, permission: "read_only" } }),
	);
	await admin.dispose();

	user = await apiSignIn(`${username}@${DOMAIN}`, PASSWORD);
	await turnScreenerOff(user);
	await setSendingSettings(user, { previewEnabled: false, undoSeconds: 0 });
	storageState = await user.storageState();
	const { mailboxes } = await json<{ mailboxes: Mailbox[] }>(await user.get("/api/mailboxes"));
	const box = (localPart: string, name: string): Box => {
		const mailbox = mailboxes.find((item) => item.localPart === localPart)!;
		expect(mailbox, localPart).toBeDefined();
		return { id: mailbox.id, address: `${localPart}@${mailbox.hostname}`, name };
	};
	home = box(username, username);
	work = box(`work${token}`, "Work desk");
	desk = box(`desk${token}`, "Help desk");
	expect(mailboxes).toHaveLength(3);
});

test.afterAll(async () => {
	await user?.dispose();
});

test("All mailboxes lists every mailbox with labels and summed counts, and the filter narrows it", async ({
	browser,
}) => {
	const subjects = { home: `Home note ${token}`, work: `Work note ${token}`, desk: `Desk note ${token}` };
	await deliver(home, subjects.home);
	await deliver(work, subjects.work);
	await deliver(desk, subjects.desk);
	const page = await openPage(browser);
	await showAllMailboxes(page);

	for (const [box, subject] of [
		[home, subjects.home],
		[work, subjects.work],
		[desk, subjects.desk],
	] as const) {
		await expect(row(page, subject)).toBeVisible();
		await expect(row(page, subject).getByTestId("message-mailbox-label")).toHaveText(box.name);
	}

	const counts = async (query = "") =>
		(await json<{ counts: { folders: { inbox: { unread: number } } } }>(await user.get(`/api/messages/counts${query}`)))
			.counts.folders.inbox.unread;
	const perMailbox = await Promise.all([home, work, desk].map((box) => counts(`?mailboxId=${box.id}`)));
	const summed = perMailbox.reduce((total, count) => total + count, 0);
	expect(summed).toBe(await counts());
	const inboxLink = page
		.getByRole("navigation")
		.getByRole("link", { name: /^Inbox/ })
		.first();
	await expect(inboxLink).toContainText(String(summed));

	const switcher = await openSwitcher(page);
	await switcher.getByRole("checkbox", { name: `Show ${work.address} in All mailboxes` }).click();
	await page.keyboard.press("Escape");
	await expect(row(page, subjects.work)).toHaveCount(0);
	await expect(row(page, subjects.home)).toBeVisible();
	await expect(row(page, subjects.desk)).toBeVisible();
	await expect(inboxLink).toContainText(String(summed - perMailbox[1]));

	// The choice is remembered by the browser.
	await page.reload();
	await expect(row(page, subjects.home)).toBeVisible();
	await expect(row(page, subjects.work)).toHaveCount(0);
	const reopened = await openSwitcher(page);
	await reopened.getByRole("checkbox", { name: `Show ${work.address} in All mailboxes` }).click();
	await page.keyboard.press("Escape");
	await expect(row(page, subjects.work)).toBeVisible();

	// Choosing one mailbox leaves the combined view.
	await (await openSwitcher(page)).getByRole("option", { name: new RegExp(work.address) }).click();
	await expect(page.getByRole("button", { name: `Switch mailbox, current: ${work.address}` })).toBeVisible();
	await expect(row(page, subjects.work)).toBeVisible();
	await expect(row(page, subjects.home)).toHaveCount(0);
	await expect(row(page, subjects.work).getByTestId("message-mailbox-label")).toHaveCount(0);
	await page.context().close();
});

test("a reply goes out from the mailbox the message arrived in, and a new message offers the last From", async ({
	browser,
}) => {
	const subjects = { home: `Reply home ${token}`, work: `Reply work ${token}` };
	await deliver(home, subjects.home);
	await deliver(work, subjects.work);
	const page = await openPage(browser);
	await showAllMailboxes(page);

	for (const [box, subject] of [
		[home, subjects.home],
		[work, subjects.work],
	] as const) {
		await row(page, subject).getByRole("link").first().click();
		await expect(page.getByRole("heading", { level: 1, name: subject })).toBeVisible();
		await page.keyboard.press("r");
		await expect(page.getByLabel("Subject")).toHaveValue(`Re: ${subject}`);
		await expectSelectValue(page.getByRole("combobox", { name: "From" }), `${box.id}|${box.address}`);
		await page.getByRole("textbox", { name: "Message body" }).click();
		await page.keyboard.type(`Answer from ${box.name}.`);
		const sent = page.waitForResponse(
			(response) => response.url().endsWith("/api/send") && response.request().method() === "POST",
		);
		await page.getByRole("button", { name: "Send", exact: true }).click();
		expect((await sent).ok()).toBe(true);
		await page.getByRole("button", { name: "Close composer" }).click();
		await expect
			.poll(async () =>
				(await listMessages(`direction=outbound&status=sent&mailboxId=${box.id}`)).some(
					(message) => message.subject === `Re: ${subject}`,
				),
			)
			.toBe(true);
	}
	const homeSent = await listMessages(`direction=outbound&status=sent&mailboxId=${home.id}`);
	expect(homeSent.some((message) => message.subject === `Re: ${subjects.work}`)).toBe(false);
	// Replying never switched the view to one mailbox.
	await expect(page.getByRole("button", { name: "Switch mailbox, current: All mailboxes" })).toBeVisible();

	await page.goto("/inbox");
	await page.getByRole("button", { name: "Compose" }).click();
	await expectSelectValue(page.getByRole("combobox", { name: "From" }), `${work.id}|${work.address}`);
	await page.getByRole("button", { name: "Close composer" }).click();
	await page.context().close();
});

test("bulk archive works across mailboxes and leaves read-only shared mail where it is", async ({ browser }) => {
	const subjects = { home: `Bulk home ${token}`, work: `Bulk work ${token}`, desk: `Bulk desk ${token}` };
	await deliver(home, subjects.home);
	await deliver(work, subjects.work);
	await deliver(desk, subjects.desk);
	const page = await openPage(browser);
	await showAllMailboxes(page);

	for (const subject of Object.values(subjects)) {
		await row(page, subject).getByRole("checkbox").click();
	}
	await page.getByRole("button", { name: "Move to" }).click();
	await expect(page.getByText("Select mail from one mailbox to move it to a folder.")).toBeVisible();
	await page.keyboard.press("Escape");
	await page.getByRole("button", { name: "Archive", exact: true }).first().click();
	await expect(page.getByText("1 read-only message was left as it was.")).toBeVisible();
	await expect(row(page, subjects.home)).toHaveCount(0);
	await expect(row(page, subjects.work)).toHaveCount(0);
	await expect(row(page, subjects.desk)).toBeVisible();

	const archived = await listMessages("status=archived");
	expect(archived.filter((message) => message.subject === subjects.home)[0]?.mailboxId).toBe(home.id);
	expect(archived.filter((message) => message.subject === subjects.work)[0]?.mailboxId).toBe(work.id);
	expect(archived.some((message) => message.subject === subjects.desk)).toBe(false);
	await page.context().close();
});

test("read-only shared mail cannot be archived or deleted from the combined view", async ({ browser }) => {
	const subject = `Read only ${token}`;
	await deliver(desk, subject);
	const page = await openPage(browser);
	await showAllMailboxes(page);

	await row(page, subject).getByRole("checkbox").click();
	await expect(page.getByRole("button", { name: "Archive", exact: true }).first()).toBeDisabled();
	await expect(page.getByRole("button", { name: "Delete", exact: true }).first()).toBeDisabled();
	await expect(page.getByRole("button", { name: "Mark as read" }).first()).toBeEnabled();
	await row(page, subject).getByRole("checkbox").click();

	await row(page, subject).getByRole("link").first().click();
	await expect(page.getByRole("heading", { level: 1, name: subject })).toBeVisible();
	await expect(page.getByRole("button", { name: /^Archive/ })).toBeDisabled();
	await expect(page.getByRole("button", { name: /^Move to trash/ })).toBeDisabled();
	await page.keyboard.press("e");
	await expect(page.getByText("Read-only mail can't be moved or deleted.")).toBeVisible();
	await expect(page.getByRole("heading", { level: 1, name: subject })).toBeVisible();

	const [stored] = (await listMessages(`mailboxId=${desk.id}`)).filter((message) => message.subject === subject);
	expect(stored.status).toBe("received");
	expect((await user.post("/api/messages/bulk", { data: { action: "trash", messageIds: [stored.id] } })).status()).toBe(
		404,
	);
	await page.context().close();
});

test("j, k, e and # work in the combined view", async ({ browser }) => {
	const subjects = [`Keys home ${token}`, `Keys work ${token}`, `Keys home two ${token}`];
	await deliver(home, subjects[0]);
	await deliver(work, subjects[1]);
	await deliver(home, subjects[2]);
	const page = await openPage(browser);
	await showAllMailboxes(page);
	const link = (subject: string) => row(page, subject).getByRole("link").first();
	await expect(link(subjects[2])).toBeVisible();

	await page.keyboard.press("j");
	await expect(link(subjects[2])).toBeFocused();
	await page.keyboard.press("j");
	await expect(link(subjects[1])).toBeFocused();
	await page.keyboard.press("e");
	await expect(row(page, subjects[1])).toHaveCount(0);
	await link(subjects[0]).focus();
	await page.keyboard.press("#");
	await expect(row(page, subjects[0])).toHaveCount(0);

	expect((await listMessages(`status=archived&mailboxId=${work.id}`)).some((m) => m.subject === subjects[1])).toBe(
		true,
	);
	expect((await listMessages(`status=trash&mailboxId=${home.id}`)).some((m) => m.subject === subjects[0])).toBe(true);
	await page.context().close();
});

test("on a phone the combined view shows one pane at a time", async ({ browser }) => {
	const subject = `Phone all ${token}`;
	await deliver(work, subject);
	const page = await openPage(browser, { width: 390, height: 844 });
	await page.goto("/inbox");
	await page.getByRole("button", { name: "Open menu" }).click();
	const sheet = page.getByRole("dialog", { name: "Menu" });
	await sheet.getByRole("button", { name: /^Switch mailbox, current:/ }).click();
	await page
		.getByRole("listbox", { name: "Mailboxes" })
		.getByRole("option", { name: /All mailboxes/ })
		.click();
	await page.keyboard.press("Escape");

	await expect(row(page, subject)).toBeVisible();
	await expect(row(page, subject).getByTestId("message-mailbox-label")).toHaveText(work.name);
	await row(page, subject).getByText(subject, { exact: true }).click();
	await expect(page.getByRole("heading", { level: 1, name: subject })).toBeVisible();
	await expect(inboxList(page)).toHaveCount(0);
	await page.getByRole("button", { name: "Back to Inbox" }).click();
	await expect(row(page, subject)).toBeVisible();
	await page.context().close();
});
