import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import { DOMAIN, STORAGE_STATE } from "./support/constants";
import { createSharedMailbox, createSignedInAccount, okJson, selectMailbox, shareMailbox } from "./support/auto-read";
import { apiContext, postInbound, suppressMailboxTour, uniqueToken, waitForMessage } from "./support/helpers";
import type { StoredMessage } from "./support/helpers-types";

// Notes on conversations (ported from upstream Mailflare #237): a colleague with send access writes and edits notes
// in a shared mailbox, a read-only member reads them without a composer, and the owner deletes one. Notes show on
// every email of the conversation and never leave Kite.

let api: APIRequestContext;

test.beforeAll(async () => {
	api = await apiContext(STORAGE_STATE);
});

test.afterAll(async () => {
	await api?.dispose();
});

/** Two emails from outside, the second a reply to the first, delivered to `to`. */
async function deliverConversation(to: string): Promise<{ first: StoredMessage; second: StoredMessage }> {
	const subject = uniqueToken("Refund request");
	const messageId = `<${uniqueToken("note")}@outside.test>`;
	await postInbound(api, {
		from: "Maya Lopez <maya@outside.test>",
		to,
		subject,
		text: "Can I get a refund?",
		messageId,
	});
	const first = await waitForMessage(api, subject);
	await postInbound(api, {
		from: "Maya Lopez <maya@outside.test>",
		to,
		subject: `Re: ${subject}`,
		text: "Any news?",
		messageId: `<${uniqueToken("note")}@outside.test>`,
		inReplyTo: messageId,
	});
	const second = await waitForMessage(api, `Re: ${subject}`);
	return { first, second };
}

async function signedInPage(
	browser: Browser,
	client: APIRequestContext,
	mailboxId: string,
	viewport?: { width: number; height: number },
) {
	const context = await browser.newContext({
		storageState: await client.storageState(),
		...(viewport ? { viewport } : {}),
	});
	const page = await context.newPage();
	await suppressMailboxTour(page);
	await selectMailbox(page, mailboxId);
	return { context, page };
}

const band = (page: Page) => page.getByRole("region", { name: "Notes" });
const notesButton = (page: Page) => page.getByTestId("conversation-notes-button");

test("a colleague writes notes, a read-only member reads them, and the owner deletes one", async ({ browser }) => {
	const localPart = uniqueToken("notes");
	const mailboxId = await createSharedMailbox(api, localPart);
	const helper = await createSignedInAccount(api, uniqueToken("noteshelp"));
	const reader = await createSignedInAccount(api, uniqueToken("notesread"));
	await shareMailbox(api, mailboxId, helper.id, "send_on_behalf");
	await shareMailbox(api, mailboxId, reader.id, "read_only");
	try {
		const { first, second } = await deliverConversation(`${localPart}@${DOMAIN}`);

		// The colleague: no notes yet, so the button offers to add one and opens the composer.
		const writer = await signedInPage(browser, helper.api, mailboxId);
		try {
			const page = writer.page;
			await page.goto(`/inbox/${first.id}`);
			await expect(notesButton(page)).toHaveAccessibleName("Add a note");
			await expect(band(page)).toHaveCount(0);
			await notesButton(page).click();
			const composer = band(page).getByRole("textbox", { name: "Write a note" });
			await expect(composer).toBeFocused();
			await composer.fill("Maya is a VIP customer, answer within the hour.");
			await band(page).getByRole("button", { name: "Add note" }).click();
			await expect(band(page).locator("[data-note-id]")).toHaveCount(1);
			await expect(composer).toHaveValue("");
			// The options stay while focus moves from the empty composer to them by keyboard.
			await composer.focus();
			await page.keyboard.press("Tab");
			await expect(band(page).getByRole("checkbox", { name: "About this email only" })).toBeFocused();

			await composer.fill("Refund approved, see the order from last week.");
			await band(page).getByText("About this email only").click();
			await composer.press("Control+Enter");
			await expect(band(page).locator("[data-note-id]")).toHaveCount(2);
			await expect(notesButton(page)).toHaveAccessibleName("2 notes");
			await expect(band(page).getByRole("button", { name: /^About the email from Maya Lopez/ })).toBeVisible();

			// Editing their own note marks it edited.
			const firstNote = band(page).locator("[data-note-id]").first();
			await firstNote.getByRole("button", { name: "Edit note" }).click();
			const editor = firstNote.getByRole("textbox", { name: "Edit note" });
			await editor.fill("Maya is a VIP customer, answer within 30 minutes.");
			await firstNote.getByRole("button", { name: "Save" }).click();
			await expect(firstNote).toContainText("answer within 30 minutes");
			await expect(firstNote).toContainText("(edited)");

			// Hide and show again from the toolbar.
			await band(page).getByRole("button", { name: "Hide notes" }).click();
			await expect(band(page)).toHaveCount(0);
			await notesButton(page).click();
			await expect(band(page)).toBeVisible();
		} finally {
			await writer.context.close();
		}

		// The read-only member opens the reply: the notes are there, without a composer or actions.
		const readOnly = await signedInPage(browser, reader.api, mailboxId);
		try {
			const page = readOnly.page;
			await page.goto(`/inbox/${second.id}`);
			await expect(band(page)).toBeVisible();
			await expect(band(page).locator("[data-note-id]")).toHaveCount(2);
			await expect(band(page)).toContainText("answer within 30 minutes");
			await expect(band(page).getByRole("textbox")).toHaveCount(0);
			await expect(band(page).getByRole("button", { name: /^(Edit|Delete) note$/ })).toHaveCount(0);
			await expect(band(page)).toContainText("You have read-only access to this mailbox");
			// Clicking the pin chip scrolls to the email the note is about.
			await band(page)
				.getByRole("button", { name: /^About the email from Maya Lopez/ })
				.click();
			await expect(page.locator(`[data-message-id="${first.id}"]`)).toBeInViewport();
		} finally {
			await readOnly.context.close();
		}
		const refused = await reader.api.post(`/api/messages/${second.id}/notes`, { data: { body: "Sneaky" } });
		expect(refused.status()).toBe(403);
		expect(await refused.json()).toMatchObject({ code: "READ_ONLY" });

		// The owner (full access) cannot edit the colleague's note but can delete it.
		const owner = await signedInPage(browser, api, mailboxId);
		try {
			const page = owner.page;
			await page.goto(`/inbox/${first.id}`);
			const note = band(page).locator("[data-note-id]").first();
			await expect(note.getByRole("button", { name: "Edit note" })).toHaveCount(0);
			await note.getByRole("button", { name: "Delete note" }).click();
			const confirm = page.getByRole("alertdialog");
			await expect(confirm).toContainText("Delete this note?");
			await confirm.getByRole("button", { name: "Delete" }).click();
			await expect(band(page).locator("[data-note-id]")).toHaveCount(1);
			await expect(notesButton(page)).toHaveAccessibleName("1 note");
		} finally {
			await owner.context.close();
		}
		const { notes } = await okJson<{ notes: { body: string }[] }>(await api.get(`/api/messages/${second.id}/notes`));
		expect(notes.map((note) => note.body)).toEqual(["Refund approved, see the order from last week."]);
	} finally {
		await helper.api.dispose();
		await reader.api.dispose();
	}
});

test("on a phone the notes fit the screen, and Notes is reachable from More actions when the row is full", async ({
	browser,
}) => {
	const localPart = uniqueToken("notesphone");
	const mailboxId = await createSharedMailbox(api, localPart);
	const { first } = await deliverConversation(`${localPart}@${DOMAIN}`);
	await okJson(await api.post(`/api/messages/${first.id}/notes`, { data: { body: "Call Maya back after 3 pm." } }));
	const { context, page } = await signedInPage(browser, api, mailboxId, { width: 375, height: 812 });
	try {
		await page.goto(`/inbox/${first.id}`);
		await expect(band(page)).toContainText("Call Maya back after 3 pm.");
		const box = await band(page).boundingBox();
		expect(box!.x).toBeGreaterThanOrEqual(0);
		expect(box!.x + box!.width).toBeLessThanOrEqual(375);
		expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);

		// On the smallest phone the row keeps Delete and More actions; Notes moves into the menu and opens the band.
		await page.setViewportSize({ width: 320, height: 640 });
		await band(page).getByRole("button", { name: "Hide notes" }).click();
		await expect(band(page)).toHaveCount(0);
		const more = page.locator(".reader-toolbar").getByRole("button", { name: "More actions" });
		if (await notesButton(page).isVisible()) {
			await notesButton(page).click();
		} else {
			await more.click();
			await page.getByRole("dialog", { name: "More actions" }).getByRole("button", { name: "1 note" }).click();
		}
		await expect(band(page)).toContainText("Call Maya back after 3 pm.");
		const moreBox = await more.boundingBox();
		expect(moreBox!.x + moreBox!.width).toBeLessThanOrEqual(320);
	} finally {
		await context.close();
	}
});
