import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { STORAGE_STATE, SUPPORT_ADDRESS } from "./support/constants";
import { apiContext, deliverInbound, openMessage, postInbound, uniqueToken, waitForMessage } from "./support/helpers";
import type { StoredMessage } from "./support/helpers-types";
import { dateFromZonedFields, zonedDateFields } from "../src/lib/time/utils";

let api: APIRequestContext;

test.beforeAll(async () => {
	api = await apiContext(STORAGE_STATE);
});

test.afterAll(async () => {
	await api.dispose();
});

async function deliver(label: string): Promise<{ subject: string; message: StoredMessage }> {
	const subject = `${label} ${uniqueToken()}`;
	const message = await deliverInbound(api, {
		from: `"Organiser" <organiser@outside.test>`,
		to: SUPPORT_ADDRESS,
		subject,
	});
	return { subject, message };
}

/** Posts `count` messages in order, then waits for all of them; order matters for list paging. */
async function deliverMany(label: string, count: number) {
	const mails = Array.from({ length: count }, (_, index) => ({
		from: `"Organiser" <organiser@outside.test>`,
		to: SUPPORT_ADDRESS,
		subject: `${label} ${index}`,
	}));
	for (const mail of mails) await postInbound(api, mail);
	return Promise.all(
		mails.map(async (mail) => ({ subject: mail.subject, message: await waitForMessage(api, mail.subject) })),
	);
}

async function messageStatusCode(id: string): Promise<number> {
	return (await api.get(`/api/messages/${id}`)).status();
}

/** The list row for a subject; its actions only take pointer events while hovered. */
function messageRow(page: Page, subject: string) {
	return page
		.getByRole("main")
		.locator("div.group")
		.filter({ has: page.getByText(subject, { exact: true }) })
		.last();
}

test("stars and unstars a message", async ({ page }) => {
	const { subject } = await deliver("Star me");
	await page.goto("/inbox");
	const row = messageRow(page, subject);
	// The star toggle sits with the row's other actions, shown on hover.
	await row.hover();
	await row.getByRole("button", { name: "Star", exact: true, pressed: false }).click();
	await expect(row.getByRole("button", { name: "Star", exact: true, pressed: true })).toBeVisible();

	await page
		.getByRole("navigation")
		.first()
		.getByRole("link", { name: /^Starred\b/ })
		.click();
	await expect(page).toHaveURL(/\/starred$/);
	await expect(page.getByRole("main").getByText(subject, { exact: true })).toBeVisible();

	await page.goto("/inbox");
	await messageRow(page, subject).hover();
	await messageRow(page, subject).getByRole("button", { name: "Star", exact: true, pressed: true }).click();
	await expect(
		messageRow(page, subject).getByRole("button", { name: "Star", exact: true, pressed: false }),
	).toBeVisible();
	await page.goto("/starred");
	await expect(page.getByRole("main").getByText(subject, { exact: true })).toHaveCount(0);
});

test("archives a message and Undo puts it back in the inbox", async ({ page }) => {
	const { subject } = await deliver("Archive me");
	await page.goto("/inbox");
	const row = messageRow(page, subject);
	await row.hover();
	await row.getByRole("button", { name: "Archive" }).click();

	const toast = page.getByRole("status").filter({ hasText: "Message archived" });
	await expect(toast).toBeVisible();
	await expect(page.getByRole("main").getByText(subject, { exact: true })).toHaveCount(0);
	await toast.getByRole("button", { name: "Undo" }).click();
	await expect(page.getByRole("main").getByText(subject, { exact: true })).toBeVisible();

	await page.reload();
	await expect(page.getByRole("main").getByText(subject, { exact: true })).toBeVisible();
});

test("snoozing from a row opens a picker next to the button and hides the message", async ({ page }) => {
	const { subject } = await deliver("Snooze from row");
	await page.goto("/inbox");
	const row = messageRow(page, subject);
	await row.hover();
	await row.getByRole("button", { name: "Snooze" }).click();

	const picker = page.getByRole("dialog", { name: "Snooze" });
	await expect(picker).toBeVisible();
	await expect(page.getByRole("heading", { name: "Snooze email" })).toHaveCount(0);
	const trigger = await row.getByRole("button", { name: "Snooze" }).boundingBox();
	const panel = await picker.boundingBox();
	expect(trigger && panel && Math.abs(panel.y - (trigger.y + trigger.height)) < 40).toBe(true);

	await page.keyboard.press("Escape");
	await expect(picker).toBeHidden();
	await row.hover();
	await row.getByRole("button", { name: "Snooze" }).click();
	await picker.getByRole("button", { name: /^Tomorrow/ }).click();
	await expect(picker).toBeHidden();
	await expect(page.getByRole("main").getByText(subject, { exact: true })).toHaveCount(0);

	await page.goto("/snoozed");
	await expect(page.getByRole("main").getByText(subject, { exact: true })).toBeVisible();
});

test("Snooze in the reader's More actions menu expands in place", async ({ page }) => {
	const { message } = await deliver("Snooze from reader");
	await page.goto(`/inbox/${message.id}`);
	await page.getByRole("button", { name: "More actions" }).click();
	const menu = page.getByRole("dialog", { name: "More actions" });
	const snooze = menu.getByRole("button", { name: "Snooze", exact: true }).first();
	await expect(snooze).toHaveAttribute("aria-expanded", "false");
	await snooze.click();
	await expect(snooze).toHaveAttribute("aria-expanded", "true");
	await expect(page.getByRole("dialog", { name: "Snooze" })).toHaveCount(0);

	const picker = menu.getByRole("group", { name: "Snooze until" });
	await expect(picker.getByRole("button", { name: /^Next week/ })).toBeVisible();
	// The picker reads the date in the user's time zone (named in its label), which may differ
	// from the runner's, so the expected instant is built in that zone.
	const dateLabel = picker.getByText(/^Pick date & time/);
	const timeZone = /\(([^)]+)\)/.exec((await dateLabel.textContent()) ?? "")?.[1] ?? "UTC";
	const day = zonedDateFields(new Date(Date.now() + 3 * 24 * 60 * 60 * 1000), timeZone);
	day.setUTCHours(9, 30, 0, 0);
	const local = day.toISOString().slice(0, 16);
	await picker.getByLabel(/^Pick date & time/).fill(local);
	await picker.getByRole("button", { name: "Snooze", exact: true }).click();
	await expect(picker).toBeHidden();

	const expected = dateFromZonedFields(day, timeZone).toISOString();
	await expect
		.poll(async () => {
			const body = (await (await api.get(`/api/messages/${message.id}`)).json()) as {
				message: { snoozedUntil: string | null };
			};
			return body.message.snoozedUntil ? new Date(body.message.snoozedUntil).toISOString() : null;
		})
		.toBe(expected);
});

test("on a phone the More actions menu and its snooze picker stay on screen", async ({ page }) => {
	const viewport = { width: 320, height: 568 };
	await page.setViewportSize(viewport);
	const { message } = await deliver("Snooze on a phone");
	await page.goto(`/inbox/${message.id}`);
	await page.getByRole("button", { name: "More actions" }).click();
	const menu = page.getByRole("dialog", { name: "More actions" });
	await menu.getByRole("button", { name: "Snooze", exact: true }).first().click();
	await expect(menu.getByRole("group", { name: "Snooze until" })).toBeVisible();

	const box = await menu.boundingBox();
	expect(box).not.toBeNull();
	expect(box!.x).toBeGreaterThanOrEqual(0);
	expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
	expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);

	// The menu scrolls, so the custom date submit and the actions below it stay reachable.
	const submit = menu.getByRole("group", { name: "Snooze until" }).getByRole("button", { name: "Snooze", exact: true });
	await submit.scrollIntoViewIfNeeded();
	await expect(submit).toBeInViewport();
	await menu.getByRole("button", { name: "Show original" }).scrollIntoViewIfNeeded();
	await expect(menu.getByRole("button", { name: "Show original" })).toBeInViewport();

	await page.keyboard.press("Escape");
	await expect(menu).toBeHidden();
});

test("trashing the open message stays in the inbox", async ({ page }) => {
	const { subject, message } = await deliver("Trash while reading");
	await page.goto(`/inbox/${message.id}`);
	await page.getByRole("button", { name: /^Move to trash/ }).click();

	await expect(page.getByRole("status").filter({ hasText: "Message moved to Trash" })).toBeVisible();
	await expect(page).toHaveURL(/\/inbox$/);
	await expect(page.getByRole("main").getByText(subject, { exact: true })).toHaveCount(0);
});

test("moves a message to Trash and Undo restores it", async ({ page }) => {
	const { subject } = await deliver("Trash me");
	await page.goto("/inbox");
	const row = messageRow(page, subject);
	await row.hover();
	await row.getByRole("button", { name: "Trash" }).click();

	const toast = page.getByRole("status").filter({ hasText: "Message moved to Trash" });
	await expect(toast).toBeVisible();
	await expect(page.getByRole("main").getByText(subject, { exact: true })).toHaveCount(0);
	await toast.getByRole("button", { name: "Undo" }).click();
	await expect(page.getByRole("main").getByText(subject, { exact: true })).toBeVisible();

	await page.goto("/trash");
	await expect(page.getByRole("main").getByText(subject, { exact: true })).toHaveCount(0);
});

test("deleting forever from Trash asks for confirmation first", async ({ page }) => {
	const { subject, message } = await deliver("Delete me");
	const trashed = await api.post("/api/messages/bulk", { data: { messageIds: [message.id], action: "trash" } });
	expect(trashed.ok(), await trashed.text()).toBe(true);

	await page.goto("/trash");
	const row = messageRow(page, subject);
	await expect(row).toBeVisible();
	await row.getByRole("checkbox").check();
	await clickBulkAction(page, "Delete forever");

	const confirm = page.getByRole("alertdialog", { name: "Delete forever?" });
	await expect(confirm).toBeVisible();
	await confirm.getByRole("button", { name: "Cancel" }).click();
	await expect(confirm).toBeHidden();
	await expect(row).toBeVisible();
	expect(await messageStatusCode(message.id)).toBe(200);

	await clickBulkAction(page, "Delete forever");
	await expect(confirm).toBeVisible();
	await confirm.getByRole("button", { name: "Delete forever" }).click();
	await expect(confirm).toBeHidden();
	await expect(page.getByRole("main").getByText(subject, { exact: true })).toHaveCount(0);
	await expect.poll(() => messageStatusCode(message.id)).toBe(404);
});

test("deleting a page of messages forever shows progress and removes them", async ({ page }) => {
	const token = uniqueToken();
	const delivered = await deliverMany(`Bulk delete ${token}`, 30);
	const ids = delivered.map(({ message }) => message.id);
	const trashed = await api.post("/api/messages/bulk", { data: { messageIds: ids, action: "trash" } });
	expect(trashed.ok(), await trashed.text()).toBe(true);

	await page.goto("/trash");
	const mine = page.getByRole("main").getByText(new RegExp(`^Bulk delete ${token} \\d+$`));
	await expect(mine.first()).toBeVisible();
	// Messages arriving in the same instant have no fixed order, so read which ones the page shows.
	const shown = await mine.allTextContents();
	// The select-all checkbox is always in the list header; no separate "Select" mode is needed for a pointer.
	await page.getByRole("checkbox", { name: "Select all visible messages" }).check();
	await clickBulkAction(page, "Delete forever");
	await page
		.getByRole("alertdialog", { name: "Delete forever?" })
		.getByRole("button", { name: "Delete forever" })
		.click();

	await expect(page.getByRole("status").filter({ hasText: /\d+ messages deleted forever/ })).toBeVisible({
		timeout: 60_000,
	});
	await expect(mine).toHaveCount(0);
	const deletedIds = delivered.filter(({ subject }) => shown.includes(subject)).map(({ message }) => message.id);
	expect(deletedIds.length).toBeGreaterThan(0);
	expect(deletedIds).toHaveLength(shown.length);
	const statuses = await Promise.all(deletedIds.map((id) => messageStatusCode(id)));
	expect(statuses.every((status) => status === 404)).toBe(true);
});

/** The bulk toolbar in the list header: its action buttons sit beside the "N selected" count. */
function selectionPane(page: Page) {
	return page.getByTestId("bulk-toolbar");
}

/**
 * Runs a bulk toolbar action by its label, whether the list beside the open message has room to show it
 * inline or, at the default split-pane width, it only reaches through "More actions": what fits there is
 * measured against the panel's actual width, not a fixed set, so any action (not just the lower-priority
 * ones) can fold away depending on how many are competing for the room.
 */
async function clickBulkAction(page: Page, action: string) {
	const inline = selectionPane(page).getByRole("button", { name: action, exact: true });
	if (await inline.isVisible()) {
		await inline.click();
		return;
	}
	await selectionPane(page).getByRole("button", { name: "More actions" }).click();
	await page.getByRole("menu").getByRole("menuitem", { name: action, exact: true }).click();
}

async function openWithSelection(page: Page, open: string, others: string[]) {
	await page.goto("/inbox");
	await openMessage(page, open);
	await expect(page).toHaveURL(/\/inbox\/[^/]+$/);
	for (const subject of others) await messageRow(page, subject).getByRole("checkbox").check();
	await expect(page.getByText(`${others.length} selected`)).toBeVisible();
}

async function expectEmptyPane(page: Page, route: string) {
	await expect(page).toHaveURL(new RegExp(`${route}$`));
	await expect(page.getByTestId("reading-pane-empty")).toBeVisible();
	await expect(page.getByText(/^\d+ selected$/)).toHaveCount(0);
}

type OldMessageTimings = { inserted: number[]; mutated: number | null };

/**
 * Records every time the old message heading is added to the DOM (with performance.now()), the time
 * the first mutating response (bulk action or Empty Trash/Spam) reaches the page, and every 404 for
 * its message or thread. Install it before the action under test; it first waits for the page's own
 * loads to finish. `assertNone` only fails on insertions after the mutation succeeded (all of them
 * when there was no mutation).
 */
async function watchOldMessage(page: Page, subject: string, messageIds: string[]) {
	// A heading can show from the list's primed copy while the message and thread GETs are still in
	// flight; those would land after the delete and 404, or re-insert the heading, through no fault of
	// the action under test.
	await page.waitForLoadState("networkidle");
	const missing: string[] = [];
	page.on("response", (response) => {
		const { pathname } = new URL(response.url());
		if (response.status() === 404 && messageIds.some((id) => pathname.startsWith(`/api/messages/${id}`)))
			missing.push(pathname);
	});
	await page.evaluate((text) => {
		const win = window as unknown as { __oldMessage: OldMessageTimings };
		win.__oldMessage = { inserted: [], mutated: null };
		const originalFetch = window.fetch.bind(window);
		window.fetch = async (input, init) => {
			const response = await originalFetch(input, init);
			const url = new URL(input instanceof Request ? input.url : String(input), location.href);
			const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
			if (
				response.ok &&
				method !== "GET" &&
				url.pathname.startsWith("/api/messages") &&
				win.__oldMessage.mutated === null
			)
				win.__oldMessage.mutated = performance.now();
			return response;
		};
		const matches = (node: Node) =>
			node instanceof Element &&
			[node, ...node.querySelectorAll("h1")].some((el) => el.matches("h1") && el.textContent === text);
		new MutationObserver((records) => {
			for (const record of records)
				for (const node of record.addedNodes) if (matches(node)) win.__oldMessage.inserted.push(performance.now());
		}).observe(document.body, { childList: true, subtree: true });
	}, subject);
	return {
		async assertNone() {
			const { inserted, mutated } = await page.evaluate(
				() => (window as unknown as { __oldMessage: OldMessageTimings }).__oldMessage,
			);
			expect(
				inserted.filter((at) => at >= (mutated ?? 0)),
				`old heading inserted after mutation success (inserted at ${JSON.stringify(inserted)}, success at ${mutated})`,
			).toEqual([]);
			expect(missing).toEqual([]);
		},
	};
}

for (const action of ["Delete", "Archive"]) {
	test(`${action} on a selection with a message open returns to the empty pane`, async ({ page }) => {
		const token = uniqueToken();
		const open = await deliver(`Open ${token}`);
		const b = await deliver(`Pick B ${token}`);
		const c = await deliver(`Pick C ${token}`);
		await openWithSelection(page, open.subject, [b.subject, c.subject]);

		await clickBulkAction(page, action);

		await expectEmptyPane(page, "/inbox");
		await expect(page.getByRole("main").getByText(b.subject, { exact: true })).toHaveCount(0);
		await expect(page.getByRole("heading", { level: 1, name: open.subject })).toHaveCount(0);
		await expect(messageRow(page, open.subject)).toBeVisible();
	});
}

test("deleting a selection that includes the open message never shows it again", async ({ page }) => {
	const token = uniqueToken();
	const open = await deliver(`Open ${token}`);
	const b = await deliver(`Pick B ${token}`);
	await openWithSelection(page, open.subject, [b.subject]);
	await messageRow(page, open.subject).getByRole("checkbox").check();
	await expect(page.getByText("2 selected")).toBeVisible();
	const watch = await watchOldMessage(page, open.subject, [open.message.id]);

	await clickBulkAction(page, "Delete");

	await expectEmptyPane(page, "/inbox");
	await watch.assertNone();
	await expect(page.getByRole("heading", { level: 1, name: open.subject })).toHaveCount(0);
	await page.goto("/trash");
	await expect(messageRow(page, open.subject)).toBeVisible();
	await expect(messageRow(page, b.subject)).toBeVisible();
});

test("clearing the selection with a message open shows the empty pane", async ({ page }) => {
	const token = uniqueToken();
	const open = await deliver(`Open ${token}`);
	const b = await deliver(`Pick B ${token}`);
	await openWithSelection(page, open.subject, [b.subject]);
	const watch = await watchOldMessage(page, open.subject, [open.message.id]);

	await selectionPane(page).getByRole("button", { name: "Clear selection" }).click();

	await expectEmptyPane(page, "/inbox");
	await watch.assertNone();
	await expect(messageRow(page, b.subject).getByRole("checkbox")).not.toBeChecked();
});

test("a row action on a selected row drops it from the selection", async ({ page }) => {
	const token = uniqueToken();
	const a = await deliver(`Row A ${token}`);
	const b = await deliver(`Row B ${token}`);
	await page.goto("/inbox");
	await messageRow(page, a.subject).getByRole("checkbox").check();
	await messageRow(page, b.subject).getByRole("checkbox").check();
	await expect(page.getByText("2 selected")).toBeVisible();

	const row = messageRow(page, a.subject);
	await row.hover();
	await row.getByRole("button", { name: "Archive" }).click();

	await expect(messageRow(page, a.subject)).toHaveCount(0);
	await expect(page.getByText("1 selected")).toBeVisible();
	const bulk = page.waitForRequest(
		(request) => request.url().endsWith("/api/messages/bulk") && request.method() === "POST",
	);
	await clickBulkAction(page, "Delete");
	expect((await bulk).postDataJSON().messageIds).toEqual([b.message.id]);
});

test("Empty Trash clears an open trashed message, and hides behind an active selection", async ({ page }) => {
	const token = uniqueToken();
	const a = await deliver(`Trash A ${token}`);
	const b = await deliver(`Trash B ${token}`);
	const trashed = await api.post("/api/messages/bulk", {
		data: { messageIds: [a.message.id, b.message.id], action: "trash" },
	});
	expect(trashed.ok(), await trashed.text()).toBe(true);

	await page.goto("/trash");
	await openMessage(page, a.subject);
	const emptyTrash = page.getByRole("button", { name: "Empty Trash" });
	await expect(emptyTrash).toBeVisible();
	// A visible label next to the icon, not just the accessible name an aria-label alone would give it.
	await expect(emptyTrash.getByText("Empty Trash")).toBeVisible();

	// The bulk toolbar replaces the header's own actions while something is checked, the "Select" button and the
	// list settings icon among them: Empty Trash (which would wipe the whole folder, not just the selection) too.
	await messageRow(page, b.subject).getByRole("checkbox").check();
	await expect(page.getByText("1 selected")).toBeVisible();
	await expect(emptyTrash).toHaveCount(0);
	await selectionPane(page).getByRole("button", { name: "Clear selection" }).click();
	await expect(page.getByText("1 selected")).toHaveCount(0);

	const watch = await watchOldMessage(page, a.subject, [a.message.id]);
	await emptyTrash.click();
	const confirm = page.getByRole("alertdialog", { name: "Empty Trash?" });
	// The confirmation names how many messages are at stake (the seeded demo account may already hold more).
	await expect(confirm.getByText(/Permanently delete all \d+ messages in Trash/)).toBeVisible();
	await confirm.getByRole("button", { name: "Cancel" }).click();
	expect(await messageStatusCode(b.message.id)).toBe(200);

	await emptyTrash.click();
	await confirm.getByRole("button", { name: "Delete forever" }).click();

	await expectEmptyPane(page, "/trash");
	await expect(page.getByText("No emails in trash")).toBeVisible();
	await expect.poll(() => messageStatusCode(a.message.id)).toBe(404);
	await watch.assertNone();
});

test("Empty Spam shows its label and confirms with the count", async ({ page }) => {
	const token = uniqueToken();
	const a = await deliver(`Spam A ${token}`);
	const spammed = await api.post("/api/messages/bulk", { data: { messageIds: [a.message.id], action: "spam" } });
	expect(spammed.ok(), await spammed.text()).toBe(true);

	await page.goto("/spam");
	const emptySpam = page.getByRole("button", { name: "Empty Spam" });
	await expect(emptySpam).toBeVisible();
	// A visible label next to the icon, not just the accessible name an aria-label alone would give it.
	await expect(emptySpam.getByText("Empty Spam")).toBeVisible();

	await emptySpam.click();
	const confirm = page.getByRole("alertdialog", { name: "Empty Spam?" });
	await expect(confirm.getByText(/Permanently delete (the 1 message|all \d+ messages) in Spam/)).toBeVisible();
	await confirm.getByRole("button", { name: "Delete forever" }).click();

	await expect(page).toHaveURL(/\/spam$/);
	await expect.poll(() => messageStatusCode(a.message.id)).toBe(404);
});

test("Empty Trash with an open threaded message never reloads the deleted thread", async ({ page }) => {
	const token = uniqueToken();
	const originalId = `<${token}@outside.test>`;
	const first = await deliverInbound(api, {
		from: `"Organiser" <organiser@outside.test>`,
		to: SUPPORT_ADDRESS,
		subject: `Planning ${token}`,
		text: `First message ${token}`,
		messageId: originalId,
	});
	const reply = await deliverInbound(api, {
		from: `"Organiser" <organiser@outside.test>`,
		to: SUPPORT_ADDRESS,
		subject: `Re: Planning ${token}`,
		text: `Follow-up message ${token}`,
		inReplyTo: originalId,
	});
	const trashed = await api.post("/api/messages/bulk", {
		data: { messageIds: [first.id, reply.id], action: "trash" },
	});
	expect(trashed.ok(), await trashed.text()).toBe(true);

	await page.goto("/trash");
	await openMessage(page, `Re: Planning ${token}`);
	await expect(page).toHaveURL(/\/trash\/[^/]+$/);
	await expect(page.getByRole("heading", { level: 1, name: `Re: Planning ${token}` })).toBeVisible();
	const watch = await watchOldMessage(page, `Re: Planning ${token}`, [first.id, reply.id]);

	await page.getByRole("button", { name: "Empty Trash" }).click();
	await page.getByRole("alertdialog", { name: "Empty Trash?" }).getByRole("button", { name: "Delete forever" }).click();

	await expectEmptyPane(page, "/trash");
	await expect.poll(() => messageStatusCode(reply.id)).toBe(404);
	await watch.assertNone();
});

/**
 * Holds list fetches and route navigations back past the 150 ms refresh debounce. `settled` resolves
 * once at least one held request has been released and none is pending, so a test can check the page
 * after the late responses have landed instead of sleeping.
 */
async function slowListAndNavigation(page: Page, delayMs = 700) {
	let released = 0;
	let pending = 0;
	await page.route(
		(url) => url.pathname === "/api/messages" || url.searchParams.has("_rsc"),
		async (route) => {
			pending += 1;
			await new Promise((resolve) => setTimeout(resolve, delayMs));
			await route.continue();
			pending -= 1;
			released += 1;
		},
	);
	return {
		async settled() {
			await expect.poll(() => released > 0 && pending === 0, { intervals: [100] }).toBe(true);
			await page.waitForLoadState("networkidle");
		},
	};
}

test("bulk Delete never remounts the open message while the list refresh and navigation are slow", async ({ page }) => {
	const token = uniqueToken();
	const open = await deliver(`Open ${token}`);
	const b = await deliver(`Pick B ${token}`);
	const c = await deliver(`Pick C ${token}`);
	await openWithSelection(page, open.subject, [b.subject, c.subject]);
	await messageRow(page, open.subject).getByRole("checkbox").check();
	await expect(page.getByText("3 selected")).toBeVisible();
	const watch = await watchOldMessage(page, open.subject, [open.message.id]);
	const slow = await slowListAndNavigation(page);

	await clickBulkAction(page, "Delete");
	await expectEmptyPane(page, "/inbox");
	await expect.poll(() => messageStatusCode(open.message.id)).toBe(200);
	await slow.settled();
	await watch.assertNone();
	await expect(page.getByRole("heading", { level: 1, name: open.subject })).toHaveCount(0);
});

async function trashThreadAndOpenReply(page: Page) {
	const token = uniqueToken();
	const originalId = `<${token}@outside.test>`;
	const first = await deliverInbound(api, {
		from: `"Organiser" <organiser@outside.test>`,
		to: SUPPORT_ADDRESS,
		subject: `Planning ${token}`,
		text: `First message ${token}`,
		messageId: originalId,
	});
	const reply = await deliverInbound(api, {
		from: `"Organiser" <organiser@outside.test>`,
		to: SUPPORT_ADDRESS,
		subject: `Re: Planning ${token}`,
		text: `Follow-up message ${token}`,
		inReplyTo: originalId,
	});
	const trashed = await api.post("/api/messages/bulk", {
		data: { messageIds: [first.id, reply.id], action: "trash" },
	});
	expect(trashed.ok(), await trashed.text()).toBe(true);
	await page.goto("/trash");
	await openMessage(page, `Re: Planning ${token}`);
	await expect(page).toHaveURL(/\/trash\/[^/]+$/);
	return { subject: `Re: Planning ${token}`, ids: [first.id, reply.id] };
}

test("Empty Trash with an open thread and no selection stays on the empty pane through a slow navigation", async ({
	page,
}) => {
	const { subject, ids } = await trashThreadAndOpenReply(page);
	await expect(page.getByRole("heading", { level: 1, name: subject })).toBeVisible();
	const watch = await watchOldMessage(page, subject, ids);
	const slow = await slowListAndNavigation(page);

	await page.getByRole("button", { name: "Empty Trash" }).click();
	await page.getByRole("alertdialog", { name: "Empty Trash?" }).getByRole("button", { name: "Delete forever" }).click();

	await expectEmptyPane(page, "/trash");
	await expect.poll(() => messageStatusCode(ids[1])).toBe(404);
	await slow.settled();
	await watch.assertNone();
});

test("Empty Trash from a later page with a message open stays on the empty pane", async ({ page }) => {
	const token = uniqueToken();
	const ids = (await deliverMany(`Paged ${token}`, 28)).map(({ message }) => message.id);
	const trashed = await api.post("/api/messages/bulk", { data: { messageIds: ids, action: "trash" } });
	expect(trashed.ok(), await trashed.text()).toBe(true);

	await page.goto("/trash");
	const mine = page.getByRole("main").getByText(new RegExp(`^Paged ${token} \\d+$`));
	await expect(mine.first()).toBeVisible();
	const firstPage = await mine.allTextContents();
	await page.getByRole("button", { name: "Next page" }).click();
	// Messages delivered in the same instant have no fixed order, so pick one the second page shows.
	await expect.poll(async () => (await mine.allTextContents()).some((text) => !firstPage.includes(text))).toBe(true);
	const subject = (await mine.allTextContents()).find((text) => !firstPage.includes(text))!;
	await openMessage(page, subject);
	await expect(page).toHaveURL(/\/trash\/[^/]+$/);
	const openId = ids[Number(subject.split(" ")[2])];
	const watch = await watchOldMessage(page, subject, [openId]);
	const slow = await slowListAndNavigation(page);

	await page.getByRole("button", { name: "Empty Trash" }).click();
	await page.getByRole("alertdialog", { name: "Empty Trash?" }).getByRole("button", { name: "Delete forever" }).click();

	await expectEmptyPane(page, "/trash");
	await expect.poll(() => messageStatusCode(openId)).toBe(404);
	await slow.settled();
	await watch.assertNone();
});

test("deleting a selection of drafts and mail spanning more than a batch asks once, for the true total", async ({
	page,
}) => {
	// Batches are BULK_ACTION_BATCH_SIZE (50) ids each: one draft lands in the first batch and, as the sole
	// oldest item, one lands alone in the second. Each batch's own 409 would say just "1 draft" on its own;
	// asking once for the true total across both is exactly what this guards.
	test.setTimeout(240_000);
	const token = uniqueToken();
	const { mailboxes } = (await (await api.get("/api/mailboxes")).json()) as { mailboxes: { id: string }[] };
	const mailboxId = mailboxes[0].id;
	async function saveDraft(subject: string): Promise<string> {
		const response = await api.post("/api/drafts", {
			data: { mailboxId, from: SUPPORT_ADDRESS, to: "customer@outside.test", subject, text: subject },
		});
		expect(response.ok(), await response.text()).toBe(true);
		return ((await response.json()) as { draft: { id: string } }).draft.id;
	}
	async function star(id: string) {
		expect((await api.post(`/api/messages/${id}/star`)).ok()).toBe(true);
	}

	// Oldest first, so it alone ranks last (the second batch) once every item below is also starred.
	const secondBatchDraft = await saveDraft(`Second batch draft ${token}`);
	await star(secondBatchDraft);
	const firstBatchDraft = await saveDraft(`First batch draft ${token}`);
	await star(firstBatchDraft);
	async function findMessages(subject: string): Promise<StoredMessage[]> {
		const response = await api.get(`/api/messages?${new URLSearchParams({ q: subject, limit: "100" })}`, {
			timeout: 60_000,
		});
		return ((await response.json()) as { messages: StoredMessage[] }).messages;
	}

	// Delivered one request at a time, then fetched in a single query instead of waitForMessage per message:
	// 49 of those in parallel is well past what a busy dev server answers inside the default timeout.
	const mailSubject = `Batch mail ${token}`;
	for (let index = 0; index < 49; index += 1) {
		await postInbound(api, { from: "sender@outside.test", to: SUPPORT_ADDRESS, subject: `${mailSubject} ${index}` });
	}
	await expect
		.poll(() => findMessages(mailSubject), { timeout: 90_000, intervals: [500, 1000, 2000] })
		.toHaveLength(49);
	const mail = await findMessages(mailSubject);
	for (const message of mail) await star(message.id);

	// The drafts are the two oldest starred items, so a page of 25 (newest first) need not show them: the
	// banner below reaches the whole folder regardless of what the first page happens to display.
	await page.goto("/starred");
	await expect(page.getByText(new RegExp(`^Batch mail ${token} \\d+$`)).first()).toBeVisible();
	await page.getByRole("checkbox", { name: "Select all visible messages" }).check();
	const banner = page.getByRole("button", { name: /^Select all 51 in Starred$/ });
	await expect(banner).toBeVisible();
	await banner.click();
	await expect(page.getByText("51 selected")).toBeVisible();

	await clickBulkAction(page, "Delete");
	const confirm = page.getByRole("alertdialog", { name: "Delete 2 drafts permanently?" });
	await expect(confirm).toBeVisible();
	await confirm.getByRole("button", { name: "Delete" }).click();

	await expect.poll(() => messageStatusCode(secondBatchDraft)).toBe(404);
	await expect.poll(() => messageStatusCode(firstBatchDraft)).toBe(404);
	for (const message of mail) expect((await api.get(`/api/messages/${message.id}`)).status()).toBe(200);
	await expect
		.poll(async () => (await (await api.get(`/api/messages/${mail[0].id}`)).json()).message.status)
		.toBe("trash");
});
