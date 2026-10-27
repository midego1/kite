import { expect, test, type Page } from "@playwright/test";
import { STORAGE_STATE, SUPPORT_ADDRESS } from "./support/constants";
import { apiContext, deliverInbound, setSendingSettings, uniqueToken, waitForMessage } from "./support/helpers";

// The reader after Zero's: replies open docked under the message instead of in a separate window, the
// sidebar carries the notices, and the app is dark unless the user picks otherwise.

async function deliverOne(label: string): Promise<string> {
	const api = await apiContext(STORAGE_STATE);
	const subject = `${label} ${uniqueToken()}`;
	await deliverInbound(api, {
		from: `"Inline Sender" <inline@outside.test>`,
		to: SUPPORT_ADDRESS,
		headers: { Cc: "colleague@outside.test" },
		subject,
		text: `Body of ${label}.`,
	});
	await api.dispose();
	return subject;
}

async function openMessage(page: Page, subject: string) {
	await page.goto("/inbox");
	await page
		.getByRole("list", { name: "Inbox" })
		.locator("[data-message-row]")
		.filter({ has: page.getByText(subject, { exact: true }) })
		.getByRole("link")
		.click();
	await expect(page.getByRole("heading", { level: 1, name: subject })).toBeVisible();
}

/** The reply composer docked in the reader, not the floating window (which has a Minimize button). */
function inlineComposer(page: Page) {
	return page
		.getByRole("main")
		.getByRole("region", { name: "Compose message" })
		.filter({ has: page.getByRole("button", { name: "Pop out composer" }) });
}

async function draftsFor(subject: string): Promise<{ subject: string | null; textBody?: string | null }[]> {
	const api = await apiContext(STORAGE_STATE);
	const params = new URLSearchParams({ status: "draft", q: subject, limit: "10" });
	const data = (await (await api.get(`/api/messages?${params}`)).json()) as {
		messages: { subject: string | null; snippet?: string | null }[];
	};
	await api.dispose();
	return data.messages.map((message) => ({ subject: message.subject, textBody: message.snippet }));
}

test("the reply box expands into the composer under the message, and a reply sent from it reaches Sent", async ({
	page,
}) => {
	const api = await apiContext(STORAGE_STATE);
	await setSendingSettings(api, { previewEnabled: false, undoSeconds: 0 });
	const subject = await deliverOne("Inline send");
	await openMessage(page, subject);

	await page.getByRole("button", { name: /^Reply to Inline Sender/ }).click();
	const composer = inlineComposer(page);
	await expect(composer).toBeVisible();
	await expect(page.getByRole("button", { name: "Minimize composer" })).toHaveCount(0);
	await expect(composer.getByRole("button", { name: /^Remove .*inline@outside\.test/ })).toBeVisible();
	const body = composer.getByRole("textbox", { name: "Message body" });
	await expect(body).toBeFocused();
	await body.pressSequentially("Thanks, sending this from the reader.");

	const sent = page.waitForResponse(
		(response) => response.url().endsWith("/api/send") && response.request().method() === "POST",
	);
	await composer.getByRole("button", { name: "Send", exact: true }).click();
	expect((await sent).ok()).toBe(true);
	await expect(inlineComposer(page)).toHaveCount(0);
	await expect(page.getByRole("button", { name: /^Reply to Inline Sender/ })).toBeVisible();

	await waitForMessage(api, `Re: ${subject}`, { status: "sent" });
	await api.dispose();
	await page.goto("/sent");
	await expect(page.getByRole("main").getByText(`Re: ${subject}`, { exact: true })).toBeVisible();
});

test("r, a and f open the reply, reply all and forward docked in the reader with the body focused", async ({
	page,
}) => {
	const subject = await deliverOne("Inline keys");
	await openMessage(page, subject);

	for (const [key, expected, cc] of [
		["r", `Re: ${subject}`, false],
		["a", `Re: ${subject}`, true],
		["f", `Fwd: ${subject}`, false],
	] as const) {
		await page.keyboard.press(key);
		const composer = inlineComposer(page);
		await expect(composer).toBeVisible();
		await expect(composer.getByLabel("Subject")).toHaveValue(expected);
		await expect(composer.getByRole("textbox", { name: "Message body" })).toBeFocused();
		if (cc) await expect(composer.getByText("colleague@outside.test").first()).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(composer).toHaveCount(0);
	}
});

test("Esc collapses the reply and keeps its draft, the reply box resumes it, and Pop out moves it to the window", async ({
	page,
}) => {
	const subject = await deliverOne("Inline draft");
	await openMessage(page, subject);

	await page.getByRole("button", { name: /^Reply to Inline Sender/ }).click();
	const composer = inlineComposer(page);
	const body = composer.getByRole("textbox", { name: "Message body" });
	await expect(body).toBeFocused();
	await body.pressSequentially("Kept after Escape");
	await page.keyboard.press("Escape");
	await expect(composer).toHaveCount(0);
	await expect
		.poll(async () => (await draftsFor(subject)).some((draft) => draft.textBody?.includes("Kept after Escape")))
		.toBe(true);

	// The reply box picks the same draft up again.
	await page.getByRole("button", { name: /^Reply to Inline Sender/ }).click();
	await expect(inlineComposer(page).getByRole("textbox", { name: "Message body" })).toContainText("Kept after Escape");

	await inlineComposer(page).getByRole("button", { name: "Pop out composer" }).click();
	await expect(inlineComposer(page)).toHaveCount(0);
	const window = page.getByRole("region", { name: "Compose message" });
	await expect(window.getByRole("button", { name: "Minimize composer" })).toBeVisible();
	await expect(window.getByRole("textbox", { name: "Message body" })).toContainText("Kept after Escape");
	await window.getByRole("button", { name: "Close composer" }).click();
	expect((await draftsFor(subject)).filter((draft) => draft.subject === `Re: ${subject}`)).toHaveLength(1);
});

test("Kite starts dark, with the sidebar's sections and the list's search and chips", async ({ page }) => {
	await page.addInitScript(() => localStorage.removeItem("kite-theme"));
	await page.goto("/inbox");
	await expect(page.locator("html")).toHaveClass(/\bdark\b/);
	await expect(page.locator("html")).toHaveAttribute("data-style", "kite");
	const nav = page.getByRole("navigation", { name: "Kite" });
	await expect(nav.getByText("Core", { exact: true })).toBeVisible();
	await expect(nav.getByRole("button", { name: "Management" })).toHaveAttribute("aria-expanded", "false");
	await expect(nav.getByRole("button", { name: "Compose new email" })).toBeVisible();
	await expect(nav.getByRole("link", { name: "Settings" })).toBeVisible();
	const main = page.getByRole("main");
	await expect(main.getByRole("textbox", { name: /Search mail/ })).toBeVisible();
	await expect(main.getByRole("button", { name: "Primary", exact: true })).toHaveAttribute("aria-pressed", "true");
	// Checkboxes show once Select is on.
	await main.getByRole("button", { name: "Select", exact: true }).click();
	await expect(main.getByRole("checkbox", { name: "Select all visible messages" })).toBeVisible();
});

function replyBox(page: Page) {
	return page.getByRole("button", { name: /^Reply to Inline Sender/ });
}

/** Opens the docked reply from the reply box and waits until its body has the focus, ready to type in. */
async function openReply(page: Page) {
	await replyBox(page).click();
	const body = inlineComposer(page).getByRole("textbox", { name: "Message body" });
	await expect(body).toBeFocused();
	return body;
}

async function openRow(page: Page, subject: string) {
	await page
		.getByRole("list", { name: "Inbox" })
		.locator("[data-message-row]")
		.filter({ has: page.getByText(subject, { exact: true }) })
		.getByRole("link")
		.click();
	await expect(page.getByRole("heading", { level: 1, name: subject })).toBeVisible();
}

test("opening another message collapses the docked reply with its draft, and the first message resumes it", async ({
	page,
}) => {
	const first = await deliverOne("Inline switch one");
	const second = await deliverOne("Inline switch two");
	await openMessage(page, first);
	await openReply(page);
	await inlineComposer(page).getByRole("textbox", { name: "Message body" }).pressSequentially("Kept across messages");

	await openRow(page, second);
	await expect(inlineComposer(page)).toHaveCount(0);
	await expect(replyBox(page)).toBeVisible();

	await openRow(page, first);
	await openReply(page);
	await expect(inlineComposer(page).getByRole("textbox", { name: "Message body" })).toContainText(
		"Kept across messages",
	);
	await page.keyboard.press("Escape");
	expect((await draftsFor(first)).filter((draft) => draft.subject === `Re: ${first}`)).toHaveLength(1);
});

test("leaving the reader while a reply is docked closes it, keeps the draft, and the reply box resumes it", async ({
	page,
}) => {
	const subject = await deliverOne("Inline leave");
	await openMessage(page, subject);
	await openReply(page);
	await inlineComposer(page).getByRole("textbox", { name: "Message body" }).pressSequentially("Kept while away");

	await page
		.getByRole("navigation", { name: "Kite" })
		.getByRole("link", { name: /^Starred\b/ })
		.click();
	await expect(page).toHaveURL(/\/starred$/);
	await expect(page.getByRole("region", { name: "Compose message" })).toHaveCount(0);

	// Back without reloading the page, which would forget what the reply box can resume.
	await page
		.getByRole("navigation", { name: "Kite" })
		.getByRole("link", { name: /^Inbox\b/ })
		.click();
	await openRow(page, subject);
	await openReply(page);
	await expect(inlineComposer(page).getByRole("textbox", { name: "Message body" })).toContainText("Kept while away");
	await page.keyboard.press("Escape");
});

test("r, Esc and r again resume one draft, and Esc gives the focus to the reply box", async ({ page }) => {
	const subject = await deliverOne("Inline resume");
	await openMessage(page, subject);
	await page.keyboard.press("r");
	const body = inlineComposer(page).getByRole("textbox", { name: "Message body" });
	await expect(body).toBeFocused();
	await body.pressSequentially("One draft only");
	await page.keyboard.press("Escape");
	await expect(inlineComposer(page)).toHaveCount(0);
	await expect(replyBox(page)).toBeFocused();

	await page.keyboard.press("r");
	await expect(inlineComposer(page).getByRole("textbox", { name: "Message body" })).toContainText("One draft only");
	await page.keyboard.press("Escape");
	await expect
		.poll(async () => (await draftsFor(subject)).filter((draft) => draft.subject === `Re: ${subject}`).length)
		.toBe(1);
});

test("a docked reply can be undone after opening another message, and the reply box never resumes a sent draft", async ({
	page,
}) => {
	const api = await apiContext(STORAGE_STATE);
	await setSendingSettings(api, { previewEnabled: false, undoSeconds: 10 });
	try {
		const first = await deliverOne("Inline undo one");
		const second = await deliverOne("Inline undo two");
		await openMessage(page, first);
		await openReply(page);
		const composer = inlineComposer(page);
		await composer.getByRole("textbox", { name: "Message body" }).pressSequentially("Undo me later");
		await composer.getByRole("button", { name: "Send", exact: true }).click();
		const undoBar = page.getByRole("status").filter({ hasText: /Sending in \d+s/ });
		await expect(undoBar).toBeVisible();

		// The undo window outlives the reader it started in.
		await openRow(page, second);
		await expect(undoBar).toBeVisible();
		await undoBar.getByRole("button", { name: "Undo" }).click();
		// No reader hosts the reply any more, so it comes back in the floating composer.
		const window = page.getByRole("region", { name: "Compose message" });
		await expect(window.getByRole("button", { name: "Minimize composer" })).toBeVisible();
		await expect(window.getByRole("textbox", { name: "Message body" })).toContainText("Undo me later");
		await window.getByRole("button", { name: "Delete draft" }).click();
		await expect(page.getByRole("region", { name: "Compose message" })).toHaveCount(0);

		// Sent, then the window runs out: nothing offers the sent draft again.
		await openRow(page, first);
		await openReply(page);
		await inlineComposer(page).getByRole("textbox", { name: "Message body" }).pressSequentially("Sent for real");
		await inlineComposer(page).getByRole("button", { name: "Send", exact: true }).click();
		await expect(undoBar).toBeVisible();
		await expect(undoBar).toHaveCount(0, { timeout: 20_000 });
		await waitForMessage(api, `Re: ${first}`, { status: "sent" });
		await openReply(page);
		const fresh = inlineComposer(page).getByRole("textbox", { name: "Message body" });
		await expect(fresh).toBeFocused();
		await expect(fresh).not.toContainText("Sent for real");
		await inlineComposer(page).getByRole("button", { name: "Delete draft" }).click();
	} finally {
		await setSendingSettings(api, { previewEnabled: false, undoSeconds: 0 });
		await api.dispose();
	}
});

test("with the preview on, a docked reply goes out through the preview and the reply box starts afresh", async ({
	page,
}) => {
	const api = await apiContext(STORAGE_STATE);
	await setSendingSettings(api, { previewEnabled: true, undoSeconds: 0 });
	try {
		const subject = await deliverOne("Inline preview");
		await openMessage(page, subject);
		await openReply(page);
		const composer = inlineComposer(page);
		await composer.getByRole("textbox", { name: "Message body" }).pressSequentially("Through the preview");
		await composer.getByRole("button", { name: "Review send" }).click();
		const dialog = page.getByRole("dialog", { name: "Preview email before sending" });
		await expect(dialog.getByText(`Re: ${subject}`)).toBeVisible();
		await dialog.getByRole("button", { name: "Confirm and send" }).click();
		await expect(inlineComposer(page)).toHaveCount(0);
		await waitForMessage(api, `Re: ${subject}`, { status: "sent" });
		await openReply(page);
		await expect(inlineComposer(page).getByRole("textbox", { name: "Message body" })).not.toContainText(
			"Through the preview",
		);
		await inlineComposer(page).getByRole("button", { name: "Delete draft" }).click();
	} finally {
		await setSendingSettings(api, { previewEnabled: false, undoSeconds: 0 });
		await api.dispose();
	}
});

test("a theme stored as Match system follows the system instead of the dark default", async ({ browser }) => {
	for (const colorScheme of ["light", "dark"] as const) {
		const context = await browser.newContext({ storageState: STORAGE_STATE, colorScheme });
		await context.addInitScript(() => localStorage.setItem("kite-theme", "system"));
		const page = await context.newPage();
		await page.goto("/inbox");
		await expect(page.getByRole("main")).toBeVisible();
		if (colorScheme === "dark") await expect(page.locator("html")).toHaveClass(/\bdark\b/);
		else await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);
		await context.close();
	}
});

test("notices show over the page while the sidebar is the icon rail and on phones", async ({ browser }) => {
	const pending = (page: Page) =>
		page.route("**/api/migrations/pending", (route) =>
			route.fulfill({ json: { pending: 1, names: ["0001_add_column.sql"] } }),
		);
	const desktop = await browser.newContext({ storageState: STORAGE_STATE });
	const page = await desktop.newPage();
	await pending(page);
	const subject = await deliverOne("Inline notices");
	await openMessage(page, subject);
	const notice = page.getByRole("region", { name: "Database updates" });
	const nav = page.getByRole("navigation", { name: "Kite" });
	await expect(nav.getByRole("region", { name: "Database updates" })).toBeVisible();
	await nav.getByRole("button", { name: "Collapse menu" }).click();
	await expect(notice).toHaveCount(1);
	await expect(notice).toBeVisible();
	await expect(nav.getByRole("region", { name: "Database updates" })).toHaveCount(0);
	await page.getByRole("button", { name: "Expand menu" }).click();
	await desktop.close();

	const phone = await browser.newContext({
		storageState: STORAGE_STATE,
		viewport: { width: 390, height: 844 },
		isMobile: true,
		hasTouch: true,
	});
	const phonePage = await phone.newPage();
	await pending(phonePage);
	await phonePage.goto("/inbox");
	await expect(phonePage.getByRole("region", { name: "Database updates" })).toBeVisible();
	await expect(phonePage.getByRole("dialog", { name: "Menu" })).toHaveCount(0);
	await phone.close();
});
