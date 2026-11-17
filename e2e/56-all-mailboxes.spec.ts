import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import { DOMAIN, STORAGE_STATE } from "./support/constants";
import {
	apiContext,
	apiSignIn,
	deliverInbound,
	setSendingSettings,
	suppressMailboxTour,
	uniqueToken,
} from "./support/helpers";
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
	const page = await context.newPage();
	await suppressMailboxTour(page);
	// These checks are about the text pill; the compact dot (the default) has its own spec, 100-message-labels.
	await page.addInitScript(() => localStorage.setItem("kite-message-labels", "full"));
	return page;
}

function inboxList(page: Page) {
	return page.getByRole("list", { name: "Inbox" });
}

function row(page: Page, subject: string) {
	return inboxList(page)
		.locator("[data-message-row]")
		.filter({ has: page.getByText(subject, { exact: true }) });
}

/** The bulk toolbar in the list header: scopes an action button away from any row's own, same-named one. */
function toolbar(page: Page) {
	return page.getByTestId("bulk-toolbar");
}

/**
 * Runs a bulk toolbar action by its label, whether the default split-pane list has room to show it inline
 * or, too narrow for that, it only reaches through "More actions": what fits there is measured against the
 * panel's actual width, not a fixed set, so any action can fold away depending on what else is competing
 * for the room.
 */
async function clickBulkAction(page: Page, action: string | RegExp) {
	const inline = toolbar(page).getByRole("button", { name: action, exact: true });
	if (await inline.isVisible()) {
		await inline.click();
		return;
	}
	await toolbar(page).getByRole("button", { name: "More actions" }).click();
	await page.getByRole("menu").getByRole("menuitem", { name: action, exact: true }).click();
}

/** Asserts `action`'s enabled state through whichever of the inline toolbar or "More actions" offers it. */
async function assertBulkActionEnabled(page: Page, action: string, enabled: boolean) {
	const inline = toolbar(page).getByRole("button", { name: action, exact: true });
	if (await inline.isVisible()) {
		await expect(inline)[enabled ? "toBeEnabled" : "toBeDisabled"]();
		return;
	}
	await toolbar(page).getByRole("button", { name: "More actions" }).click();
	await expect(page.getByRole("menu").getByRole("menuitem", { name: action, exact: true }))[
		enabled ? "toBeEnabled" : "toBeDisabled"
	]();
	await page.keyboard.press("Escape");
}

async function openSwitcher(page: Page) {
	const trigger = page.getByRole("button", { name: /^Switch mailbox, current:/ });
	// The first visit compiles the dashboard on a cold dev server.
	await expect(trigger).toBeVisible({ timeout: 60_000 });
	await trigger.click();
	// The menu holds the mailbox listbox and, outside it, the All mailboxes filter.
	return page.getByRole("dialog", { name: "Switch mailbox" });
}

/** Opens "Move to" from the bulk toolbar, inline when it fits or through "More actions" (keyboard: no pointer path). */
async function openBulkMoveMenu(page: Page) {
	const moveInline = toolbar(page).getByRole("button", { name: "Move to", exact: true });
	if (await moveInline.isVisible()) {
		await moveInline.click();
		return page.getByRole("menu").last();
	}
	await toolbar(page).getByRole("button", { name: "More actions" }).click();
	await page.getByRole("menu").getByRole("menuitem", { name: "Move to", exact: true }).press("ArrowRight");
	return page.getByRole("menu").last();
}

/** The composer docked under the open message (replies and forwards open there on a wide screen). */
function dockedComposer(page: Page) {
	return page
		.getByRole("main")
		.getByRole("region", { name: "Compose message" })
		.filter({ has: page.getByRole("button", { name: "Pop out composer" }) });
}

async function sendDocked(page: Page, body: string) {
	const composer = dockedComposer(page);
	await composer.getByRole("textbox", { name: "Message body" }).click();
	await page.keyboard.type(body);
	const sent = page.waitForResponse(
		(response) => response.url().endsWith("/api/send") && response.request().method() === "POST",
	);
	await composer.getByRole("button", { name: "Send", exact: true }).click();
	expect((await sent).ok()).toBe(true);
	await expect(composer).toHaveCount(0);
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
		await expect(row(page, subject).getByTestId("message-mailbox-label")).toHaveText(`Mailbox: ${box.name}`);
	}

	// The pill sits on the row's second line, right of the subject. In rows the account can manage it is flush
	// with the date above; the read-only mailbox's rows keep their corner star's slot (as on phones).
	const rightEdges: number[] = [];
	for (const [subject, readOnly] of [
		[subjects.home, false],
		[subjects.work, false],
		[subjects.desk, true],
	] as const) {
		const line = row(page, subject);
		const pill = await line.getByTestId("message-mailbox-label").boundingBox();
		const date = await line.locator("time").boundingBox();
		const title = await line.getByText(subject, { exact: true }).boundingBox();
		expect(pill && date && title, subject).toBeTruthy();
		const pillRight = pill!.x + pill!.width;
		const dateRight = date!.x + date!.width;
		if (readOnly) expect(pillRight, `${subject}: pill inside the row`).toBeLessThanOrEqual(dateRight);
		else rightEdges.push(Math.round(pillRight));
		expect(pill!.y, `${subject}: pill under the date`).toBeGreaterThan(date!.y + date!.height - 2);
		expect(title!.x + title!.width, `${subject}: subject ends before the pill`).toBeLessThanOrEqual(pill!.x);
		if (!readOnly) expect(pillRight, `${subject}: pill right edge`).toBeCloseTo(dateRight, 0);
	}
	expect(new Set(rightEdges).size).toBe(1);

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

	// The square before the mailbox squares at the top of the sidebar opens All mailboxes again.
	await page.getByRole("button", { name: "Open All mailboxes" }).click();
	await expect(page.getByRole("button", { name: "Open All mailboxes" })).toHaveAttribute("aria-pressed", "true");
	await expect(page.getByRole("button", { name: "Switch mailbox, current: All mailboxes" })).toBeVisible();
	await expect(row(page, subjects.home)).toBeVisible();
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
		// The reply opens in the composer docked under the message, which has no From field: the Sent copy's
		// From below is the check.
		const composer = page
			.getByRole("main")
			.getByRole("region", { name: "Compose message" })
			.filter({ has: page.getByRole("button", { name: "Pop out composer" }) });
		// Opening a reply creates its draft first, which can take a while on a busy dev server.
		await expect(composer.getByLabel("Subject")).toHaveValue(`Re: ${subject}`, { timeout: 30_000 });
		await composer.getByRole("textbox", { name: "Message body" }).click();
		await page.keyboard.type(`Answer from ${box.name}.`);
		const sent = page.waitForResponse(
			(response) => response.url().endsWith("/api/send") && response.request().method() === "POST",
		);
		await composer.getByRole("button", { name: "Send", exact: true }).click();
		expect((await sent).ok()).toBe(true);
		await expect(composer).toHaveCount(0);
		await expect
			.poll(async () =>
				(await listMessages(`direction=outbound&status=sent&mailboxId=${box.id}`))
					.filter((message) => message.subject === `Re: ${subject}`)
					.map((message) => message.fromAddr.toLowerCase().includes(box.address)),
			)
			.toEqual([true]);
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

test("reply all and forward from the combined view go out from the mailbox the message arrived in", async ({
	browser,
}) => {
	const subjects = { replyAll: `Reply all work ${token}`, forward: `Forward home ${token}` };
	await deliverInbound(user, {
		from: `"Outside Sender" <sender@outside.test>`,
		to: work.address,
		subject: subjects.replyAll,
		headers: { Cc: "colleague@outside.test" },
	});
	await deliver(home, subjects.forward);
	const page = await openPage(browser);
	await showAllMailboxes(page);

	await row(page, subjects.replyAll).getByRole("link").first().click();
	await expect(page.getByRole("heading", { level: 1, name: subjects.replyAll })).toBeVisible();
	await page.keyboard.press("a");
	await expect(dockedComposer(page).getByLabel("Subject")).toHaveValue(`Re: ${subjects.replyAll}`, {
		timeout: 30_000,
	});
	await sendDocked(page, "Answer to everyone.");

	await row(page, subjects.forward).getByRole("link").first().click();
	await expect(page.getByRole("heading", { level: 1, name: subjects.forward })).toBeVisible();
	await page.keyboard.press("f");
	const composer = dockedComposer(page);
	await expect(composer.getByLabel("Subject")).toHaveValue(`Fwd: ${subjects.forward}`, { timeout: 30_000 });
	const to = composer.getByLabel("To", { exact: true });
	await to.fill("friend@outside.test");
	await to.press("Enter");
	await sendDocked(page, "Have a look.");

	type SentMessage = ListedMessage & { toAddr: string; ccAddr: string | null };
	const sentIn = async (box: Box, subject: string) =>
		(await listMessages(`direction=outbound&status=sent&mailboxId=${box.id}`)).filter(
			(message) => message.subject === subject,
		) as SentMessage[];
	await expect.poll(async () => (await sentIn(work, `Re: ${subjects.replyAll}`)).length).toBe(1);
	const [replyAll] = await sentIn(work, `Re: ${subjects.replyAll}`);
	expect(replyAll.fromAddr.toLowerCase()).toContain(work.address);
	expect(`${replyAll.toAddr},${replyAll.ccAddr ?? ""}`).toContain("colleague@outside.test");
	await expect.poll(async () => (await sentIn(home, `Fwd: ${subjects.forward}`)).length).toBe(1);
	const [forward] = await sentIn(home, `Fwd: ${subjects.forward}`);
	expect(forward.fromAddr.toLowerCase()).toContain(home.address);
	expect(await sentIn(home, `Re: ${subjects.replyAll}`)).toEqual([]);
	expect(await sentIn(work, `Fwd: ${subjects.forward}`)).toEqual([]);
	await expect(page.getByRole("button", { name: "Switch mailbox, current: All mailboxes" })).toBeVisible();
	await page.context().close();
});

test("Move to offers only the folders of the selected mail's own mailbox", async ({ browser }) => {
	const folders = { home: `Home folder ${token}`, work: `Work folder ${token}` };
	await json(await user.post("/api/folders", { data: { mailboxId: home.id, name: folders.home } }));
	const workFolder = await json<{ id: string }>(
		await user.post("/api/folders", { data: { mailboxId: work.id, name: folders.work } }),
	);
	const subjects = { one: `Move work one ${token}`, two: `Move work two ${token}`, home: `Move home ${token}` };
	await deliver(work, subjects.one);
	await deliver(work, subjects.two);
	await deliver(home, subjects.home);
	const page = await openPage(browser);
	await showAllMailboxes(page);

	await row(page, subjects.one).getByRole("checkbox").click();
	await row(page, subjects.two).getByRole("checkbox").click();
	const menu = await openBulkMoveMenu(page);
	await expect(menu.getByRole("menuitem", { name: folders.work })).toBeVisible();
	await expect(menu.getByRole("menuitem", { name: folders.home })).toHaveCount(0);
	await menu.getByRole("menuitem", { name: folders.work }).click();
	await expect(row(page, subjects.one)).toHaveCount(0);
	await expect(row(page, subjects.two)).toHaveCount(0);
	const filed = await listMessages(`mailboxId=${work.id}&folderId=${workFolder.id}`);
	expect(filed.map((message) => message.subject).sort()).toEqual([subjects.one, subjects.two].sort());

	// The reader's Move menu lists the open message's mailbox's folders, not the other mailbox's.
	await row(page, subjects.home).getByRole("link").first().click();
	await expect(page.getByRole("heading", { level: 1, name: subjects.home })).toBeVisible();
	const toolbarMove = page.locator(".reader-toolbar").getByRole("button", { name: "Move to", exact: true });
	if (await toolbarMove.first().isVisible()) {
		await toolbarMove.first().click();
		await expect(page.getByRole("menuitem", { name: folders.home })).toBeVisible();
		await expect(page.getByRole("menuitem", { name: folders.work })).toHaveCount(0);
	} else {
		await page.locator(".reader-toolbar").getByRole("button", { name: "More actions" }).click();
		const more = page.getByRole("dialog", { name: "More actions" });
		await expect(more.getByRole("button", { name: folders.home })).toBeVisible();
		await expect(more.getByRole("button", { name: folders.work })).toHaveCount(0);
	}
	await page.keyboard.press("Escape");
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
	// The default split-pane list has no room for "Move to" inline, so it is reached through "More actions"
	// here; the keyboard opens its submenu without a pointer path across the other items first.
	const moveInline = toolbar(page).getByRole("button", { name: "Move to", exact: true });
	if (await moveInline.isVisible()) {
		await moveInline.click();
	} else {
		await toolbar(page).getByRole("button", { name: "More actions" }).click();
		await page.getByRole("menu").getByRole("menuitem", { name: "Move to", exact: true }).press("ArrowRight");
	}
	await expect(page.getByText("Select mail from one mailbox to move it to a folder.")).toBeVisible();
	await page.keyboard.press("Escape");
	await clickBulkAction(page, "Archive");
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
	// None of these has guaranteed room inline at the default split-pane width (what fits is measured, not a
	// fixed set), so each is checked through whichever of the toolbar or "More actions" actually offers it.
	await assertBulkActionEnabled(page, "Mark as read", true);
	await assertBulkActionEnabled(page, "Delete", false);
	await assertBulkActionEnabled(page, "Archive", false);
	await row(page, subject).getByRole("checkbox").click();

	await row(page, subject).getByRole("link").first().click();
	await expect(page.getByRole("heading", { level: 1, name: subject })).toBeVisible();
	await expect(page.getByRole("button", { name: "Archive (e)", exact: true })).toBeDisabled();
	await expect(page.getByRole("button", { name: "Move to trash (#)", exact: true })).toBeDisabled();
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

test("read-only shared mail cannot be answered or forwarded, in the reader or its conversation", async ({
	browser,
}) => {
	const first = `Read only thread ${token}`;
	const firstMessageId = `<ro-first-${token}@outside.test>`;
	await deliverInbound(user, {
		from: `"Outside Sender" <sender@outside.test>`,
		to: desk.address,
		subject: first,
		messageId: firstMessageId,
	});
	await deliverInbound(user, {
		from: `"Outside Sender" <sender@outside.test>`,
		to: desk.address,
		subject: `Re: ${first}`,
		inReplyTo: firstMessageId,
		headers: { References: firstMessageId },
	});
	const page = await openPage(browser);
	await showAllMailboxes(page);
	await row(page, `Re: ${first}`).getByRole("link").first().click();
	await expect(page.getByRole("heading", { level: 1, name: `Re: ${first}` })).toBeVisible();

	await expect(page.getByText("You can read this shared mailbox but not reply or forward from it.")).toBeVisible();
	await expect(page.getByRole("button", { name: /^Reply \(r\)$/ })).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Forward", exact: true })).toHaveCount(0);
	const replyButtons = page.getByRole("main").getByRole("button", { name: "Reply", exact: true });
	await expect(replyButtons.first()).toBeVisible();
	for (const button of await replyButtons.all()) await expect(button).toBeDisabled();

	await page.keyboard.press("r");
	await expect(page.getByText("Read-only mail can't be answered or forwarded.")).toBeVisible();
	await page.keyboard.press("f");
	await expect(dockedComposer(page)).toHaveCount(0);

	await page.locator(".reader-toolbar").getByRole("button", { name: "More actions" }).click();
	const more = page.getByRole("dialog", { name: "More actions" });
	await expect(more.getByRole("button", { name: "Block contact" })).toBeDisabled();
	await expect(more.getByRole("button", { name: "Report phishing" })).toBeDisabled();
	await page.keyboard.press("Escape");

	// The open message's own actions in the conversation say the same.
	const messageMenu = page.getByRole("main").getByRole("button", { name: "More actions", exact: true }).last();
	await messageMenu.click();
	for (const name of ["Reply", "Forward", "Block contact", "Archived", "Trash"]) {
		const item = page.getByRole("main").getByRole("button", { name, exact: true }).last();
		await expect(item, name).toBeDisabled();
	}
	await expect(
		page.getByRole("main").getByRole("button", { name: "Mark as unread", exact: true }).last(),
	).toBeEnabled();

	const drafts = await listMessages(`status=draft&mailboxId=${desk.id}`);
	expect(drafts).toEqual([]);
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
	// Every mailbox's rows are listed before the keys run, not the single mailbox's from before the switch.
	for (const subject of subjects) await expect(link(subject)).toBeVisible();

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
	await expect(row(page, subject).getByTestId("message-mailbox-label")).toHaveText(`Mailbox: ${work.name}`);
	await row(page, subject).getByText(subject, { exact: true }).click();
	await expect(page.getByRole("heading", { level: 1, name: subject })).toBeVisible();
	await expect(inboxList(page)).toHaveCount(0);
	await page.getByRole("button", { name: "Back to Inbox" }).click();
	await expect(row(page, subject)).toBeVisible();
	await page.context().close();
});

test("Empty Trash in the combined view empties only the mailboxes it may manage, and names them", async ({
	browser,
}) => {
	const subjects = { home: `Trash home ${token}`, desk: `Trash desk ${token}` };
	await deliver(home, subjects.home);
	await deliver(desk, subjects.desk);
	const [homeMessage] = (await listMessages(`mailboxId=${home.id}`)).filter((m) => m.subject === subjects.home);
	const [deskMessage] = (await listMessages(`mailboxId=${desk.id}`)).filter((m) => m.subject === subjects.desk);
	await json(await user.post("/api/messages/bulk", { data: { action: "trash", messageIds: [homeMessage.id] } }));
	// The shared mailbox's owner trashes its mail; for this account it stays read-only.
	const admin = await apiContext(STORAGE_STATE);
	await json(await admin.post("/api/messages/bulk", { data: { action: "trash", messageIds: [deskMessage.id] } }));
	await admin.dispose();

	const page = await openPage(browser);
	await showAllMailboxes(page);
	await page.goto("/trash");
	const list = page.getByRole("list", { name: "Trash" });
	await expect(list.getByText(subjects.home, { exact: true })).toBeVisible();
	await expect(list.getByText(subjects.desk, { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "Empty Trash" }).click();
	const confirm = page.getByRole("alertdialog", { name: "Empty Trash?" });
	await expect(confirm).toContainText(`in Trash of ${home.name}?`);
	await expect(confirm).not.toContainText(desk.name);
	await confirm.getByRole("button", { name: "Delete forever" }).click();
	await expect(list.getByText(subjects.home, { exact: true })).toHaveCount(0);
	await expect(list.getByText(subjects.desk, { exact: true })).toBeVisible();
	expect((await listMessages(`status=trash&mailboxId=${desk.id}`)).some((m) => m.id === deskMessage.id)).toBe(true);
	await page.context().close();
});

// Runs last: its deleted mail stays in Trash, which the Empty Trash test above counts.
test("bulk mark as read and delete work across mailboxes, each email staying in its own", async ({ browser }) => {
	const subjects = { home: `Read home ${token}`, work: `Read work ${token}` };
	await deliver(home, subjects.home);
	await deliver(work, subjects.work);
	const page = await openPage(browser);
	await showAllMailboxes(page);

	for (const subject of Object.values(subjects)) await row(page, subject).getByRole("checkbox").click();
	await clickBulkAction(page, "Mark as read");
	type ReadMessage = ListedMessage & { read: boolean };
	const find = async (query: string, subject: string) =>
		((await listMessages(query)) as ReadMessage[]).find((message) => message.subject === subject);
	await expect.poll(async () => (await find(`mailboxId=${home.id}`, subjects.home))?.read).toBe(true);
	await expect.poll(async () => (await find(`mailboxId=${work.id}`, subjects.work))?.read).toBe(true);

	for (const subject of Object.values(subjects)) {
		const checkbox = row(page, subject).getByRole("checkbox");
		if (!(await checkbox.isChecked())) await checkbox.click();
	}
	await clickBulkAction(page, "Delete");
	await expect(row(page, subjects.home)).toHaveCount(0);
	await expect(row(page, subjects.work)).toHaveCount(0);
	expect((await find(`status=trash&mailboxId=${home.id}`, subjects.home))?.mailboxId).toBe(home.id);
	expect((await find(`status=trash&mailboxId=${work.id}`, subjects.work))?.mailboxId).toBe(work.id);
	await page.context().close();
});
