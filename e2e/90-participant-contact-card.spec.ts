import { mkdirSync } from "node:fs";
import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";
import { BASE_URL, DOMAIN, STORAGE_STATE, SUPPORT_ADDRESS } from "./support/constants";
import { createSharedMailbox, createSignedInAccount, selectMailbox, shareMailbox } from "./support/auto-read";
import { apiContext, deliverInbound, openMessage, uniqueToken, waitForMessage } from "./support/helpers";

// The thread header's participant chips are buttons: hover shows the full address, click opens a contact
// card with Copy, New email, Search Inbox for mail from and the contact actions (only what the mailbox permission allows). The sender name in the message
// opens the same card.

/** Set to a directory to save the card's screenshots there (the PR's). */
const SHOT_DIR = process.env.CARD_SHOT_DIR;

const FIRST = "hi@cursor-card.test";
const SECOND = "roshni@cursor-card.test";
const NAME = "Roshni at Cursor";

let subject: string;

/** The trusted verdict for a sender of `domain`, which lets a reply from outside a conversation join it. */
const dmarcPass = (domain: string) =>
	`mx.cloudflare.net; dkim=pass header.d=${domain}; dmarc=pass header.from=${domain}`;
let decoySubject: string;
let spoofSubject: string;

test.beforeAll(async () => {
	const api = await apiContext(STORAGE_STATE);
	const token = uniqueToken();
	subject = `Card ${token}`;
	const first = await deliverInbound(api, {
		from: `"${NAME}" <${FIRST}>`,
		to: SUPPORT_ADDRESS,
		subject,
		text: "First message of the card thread.",
		messageId: `<${token}-1@e2e.test>`,
	});
	expect(first.id).toBeTruthy();
	// The same person writes again from a second address, in the same conversation. That address is not in it yet, so
	// the reply joins because it passed DMARC for its own domain.
	await deliverInbound(api, {
		from: `"${NAME}" <${SECOND}>`,
		to: SUPPORT_ADDRESS,
		subject: `Re: ${subject}`,
		text: "Second message of the card thread.",
		messageId: `<${token}-2@e2e.test>`,
		inReplyTo: `<${token}-1@e2e.test>`,
		headers: { "Authentication-Results": dmarcPass("cursor-card.test") },
	});
	// Look-alike senders: neither may turn up in the search for the exact address.
	decoySubject = `Decoy ${token}`;
	await deliverInbound(api, {
		from: `"Decoy" <x.${SECOND}>`,
		to: SUPPORT_ADDRESS,
		subject: decoySubject,
		text: "A sender whose address only ends like the real one.",
	});
	// A reply that borrows the display name from another domain, signed by that domain so it joins the conversation.
	spoofSubject = `Spoof ${token}`;
	await deliverInbound(api, {
		from: `"${NAME}" <${FIRST}>`,
		to: SUPPORT_ADDRESS,
		subject: spoofSubject,
		text: "The real one.",
		messageId: `<${token}-s1@e2e.test>`,
	});
	await deliverInbound(api, {
		from: `"${NAME}" <x@evil-card.test>`,
		to: SUPPORT_ADDRESS,
		subject: `Re: ${spoofSubject}`,
		text: "Not the real one.",
		messageId: `<${token}-s2@e2e.test>`,
		inReplyTo: `<${token}-s1@e2e.test>`,
		headers: { "Authentication-Results": dmarcPass("evil-card.test") },
	});
	await api.dispose();
});

async function openThread(page: Page, variant?: { style: string; theme: string }, title = subject) {
	if (variant) {
		await page.addInitScript(({ style, theme }) => {
			localStorage.setItem("kite-style", style);
			localStorage.setItem("kite-theme", theme);
		}, variant);
	}
	await page.goto("/inbox");
	await openMessage(page, new RegExp(`${title}$`));
	await expect(page.getByRole("heading", { level: 1, name: new RegExp(title) })).toBeVisible();
	return page.getByRole("list", { name: "Participants" });
}

/** A click before hydration does nothing, so click again until the card shows. */
async function openCard(page: Page, chip: Locator) {
	const card = page.getByRole("dialog", { name: /Contact card for/ });
	await expect(async () => {
		if (!(await card.isVisible())) await chip.click();
		await expect(card).toBeVisible({ timeout: 1_500 });
	}).toPass({ timeout: 20_000 });
	return card;
}

test("hover and focus show the full address and every other address of the person", async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	const chips = await openThread(page);
	const chip = chips.getByRole("button", { name: new RegExp(NAME) });
	await expect(chip).toHaveAttribute("aria-haspopup", "dialog");
	await expect(chip).toHaveAttribute("aria-expanded", "false");
	await chip.hover();
	const tip = page.getByRole("tooltip");
	await expect(tip).toContainText(/@cursor-card\.test/);
	await expect(tip).toContainText("also");
	await page.mouse.move(5, 5);
	await expect(tip).toHaveCount(0);
	// Keyboard focus shows it too.
	await chip.focus();
	await expect(page.getByRole("tooltip")).toContainText("also");
});

test("click opens the contact card: address, Copy, New email, Search Inbox for mail from, Escape", async ({
	page,
	context,
}) => {
	await context.grantPermissions(["clipboard-read", "clipboard-write"]);
	await page.setViewportSize({ width: 1440, height: 900 });
	const chips = await openThread(page);
	const chip = chips.getByRole("button", { name: new RegExp(NAME) });
	const card = await openCard(page, chip);
	await expect(chip).toHaveAttribute("aria-expanded", "true");
	await expect(card).toContainText(NAME);
	const address = await card.locator("[data-contact-card-address]").innerText();
	expect([FIRST, SECOND]).toContain(address);
	await expect(card.getByRole("button", { name: "New email" })).toBeVisible();
	await expect(card.getByRole("button", { name: `Search Inbox for mail from ${NAME}` })).toBeVisible();
	await expect(card.getByRole("button", { name: /Add to contacts|Edit contact/ })).toBeVisible();
	await expect(card.getByRole("button", { name: "Block contact" })).toBeVisible();

	// Copy puts the address on the clipboard.
	await card.getByRole("button", { name: "Copy address" }).click();
	await expect(card.getByRole("button", { name: "Address copied" })).toBeVisible();
	expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(address);

	// Tab order stays inside the card's controls and Escape closes it, returning the focus to the chip.
	await page.keyboard.press("Escape");
	await expect(card).toHaveCount(0);
	await expect(chip).toBeFocused();
	await expect(chip).toHaveAttribute("aria-expanded", "false");

	// Enter opens it from the keyboard; a click outside closes it.
	await page.keyboard.press("Enter");
	await expect(page.getByRole("dialog", { name: /Contact card for/ })).toBeVisible();
	await page.mouse.click(5, 5);
	await expect(page.getByRole("dialog", { name: /Contact card for/ })).toHaveCount(0);

	// New email opens the composer addressed to the person.
	const again = await openCard(page, chip);
	await again.getByRole("button", { name: "New email" }).click();
	await expect(page.getByRole("button", { name: `Remove ${address}` })).toBeVisible({ timeout: 20_000 });
	await page.keyboard.press("Escape");
});

test("Search Inbox for mail from lists exactly that address in the list", async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	const chips = await openThread(page);
	const card = await openCard(page, chips.getByRole("button", { name: new RegExp(NAME) }));
	const address = await card.locator("[data-contact-card-address]").innerText();
	await card.getByRole("button", { name: `Search Inbox for mail from ${NAME}` }).click();
	await expect(page).toHaveURL(/\/inbox$/);
	await expect(page.getByRole("textbox", { name: "Search mail" })).toHaveValue(`from:"${address}"`);
	await expect(
		page
			.getByRole("main")
			.getByText(new RegExp(`${subject}$`))
			.first(),
	).toBeVisible();
	await expect(page.getByRole("main").getByText(`Re: ${subject}`).first()).toBeVisible();
	// The exact address: a sender that only ends like it is not listed, in the page or in the API.
	await expect(page.getByRole("main").getByText(decoySubject)).toHaveCount(0);
	const api = await apiContext(STORAGE_STATE);
	const found = await api.get(`/api/messages?${new URLSearchParams({ q: `from:"${SECOND}"`, status: "received" })}`);
	const { messages } = (await found.json()) as { messages: { subject: string | null }[] };
	expect(messages.some((message) => message.subject === `Re: ${subject}`)).toBe(true);
	expect(messages.some((message) => message.subject === decoySubject)).toBe(false);
	const decoy = await api.get(`/api/messages?${new URLSearchParams({ q: `from:"x.${SECOND}"`, status: "received" })}`);
	const decoys = (await decoy.json()) as { messages: { subject: string | null }[] };
	expect(decoys.messages.map((message) => message.subject)).toContain(decoySubject);
	expect(decoys.messages.map((message) => message.subject)).not.toContain(`Re: ${subject}`);
	await api.dispose();
});

test("a reply that borrows the display name from another domain gets its own chip", async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	const chips = await openThread(page, undefined, `Re: ${spoofSubject}`);
	const named = chips.getByRole("button", { name: new RegExp(NAME) });
	await expect(named).toHaveCount(2);
	await named.nth(0).hover();
	const tip = page.getByRole("tooltip");
	await expect(tip).toContainText("evil-card.test");
	await expect(tip).not.toContainText("also");
	await page.mouse.move(5, 5);
	await named.nth(1).hover();
	await expect(tip).toContainText(FIRST);
	await expect(tip).not.toContainText("evil-card.test");
});

test("Block contact shows Blocked even when the contact failed to load", async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.route(
		(url) => url.pathname === "/api/contacts",
		(route) => (route.request().method() === "GET" ? route.abort() : route.continue()),
	);
	const chips = await openThread(page, undefined, decoySubject);
	const card = await openCard(page, chips.getByRole("button", { name: /Decoy/ }));
	await card.getByRole("button", { name: "Block contact" }).click();
	const confirm = card.getByRole("button", { name: "Confirm: block this contact" });
	const blocked = page.waitForResponse((response) => response.url().endsWith("/api/contacts/block"));
	await confirm.click();
	expect((await blocked).ok()).toBe(true);
	await expect(card.getByText("Blocked", { exact: true })).toBeVisible();
	await expect(card.getByRole("button", { name: /Block contact|Confirm: block/ })).toHaveCount(0);
});

/** A member of a shared mailbox with the given permission, opening a message that arrived in it. */
async function openSharedAs(browser: Browser, permission: "read_only" | "send_as") {
	const admin = await apiContext(STORAGE_STATE);
	const token = uniqueToken("cc").toLowerCase();
	const member = await createSignedInAccount(admin, `ccm${token}`);
	const localPart = `ccdesk${token}`;
	const mailboxId = await createSharedMailbox(admin, localPart);
	await shareMailbox(admin, mailboxId, member.id, permission);
	const title = `Shared ${token}`;
	await deliverInbound(admin, {
		from: `"Shared Sender" <sender@cursor-card.test>`,
		to: `${localPart}@${DOMAIN}`,
		subject: title,
		text: "Hello from the shared mailbox.",
	});
	const stored = await waitForMessage(member.api, title, { mailboxId });
	await admin.dispose();
	const context = await browser.newContext({ baseURL: BASE_URL, storageState: await member.api.storageState() });
	const page = await context.newPage();
	await selectMailbox(page, mailboxId);
	await page.addInitScript((id) => localStorage.setItem("kite-session-user", id), member.id);
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto(`/inbox/${stored.id}`);
	await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
	return { context, page, member };
}

for (const { permission, newEmail } of [
	{ permission: "read_only", newEmail: false },
	{ permission: "send_as", newEmail: true },
] as const) {
	test(`a ${permission} share sees ${newEmail ? "New email" : "no New email"} and no Edit or Block`, async ({
		browser,
	}) => {
		const { context, page, member } = await openSharedAs(browser, permission);
		try {
			const chip = page.getByRole("list", { name: "Participants" }).getByRole("button", { name: /Shared Sender/ });
			const card = await openCard(page, chip);
			await expect(card.getByRole("button", { name: "Copy address" })).toBeVisible();
			await expect(card.getByRole("button", { name: /Search Inbox for mail from/ })).toBeVisible();
			await expect(card.getByRole("button", { name: "New email" })).toHaveCount(newEmail ? 1 : 0);
			await expect(card.getByRole("button", { name: /Add to contacts|Edit contact/ })).toHaveCount(0);
			await expect(card.getByRole("button", { name: "Block contact" })).toHaveCount(0);
		} finally {
			await context.close();
			await member.api.dispose();
		}
	});
}

test("the sender name in the message opens the same card", async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await openThread(page);
	// Exact: a collapsed earlier message of the thread is a button too, named after its sender and snippet.
	const sender = page.locator("article").getByRole("button", { name: NAME, exact: true });
	const card = await openCard(page, sender);
	await expect(card).toContainText(NAME);
	await expect(card.getByRole("button", { name: "New email" })).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(card).toHaveCount(0);
});

test("your own address says You and offers no actions about someone else", async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	const chips = await openThread(page);
	const own = chips.getByRole("button", { name: /support|Support/ }).first();
	const card = await openCard(page, own);
	await expect(card.getByText("You", { exact: true })).toBeVisible();
	await expect(card.locator("[data-contact-card-address]")).toHaveText(SUPPORT_ADDRESS);
	await expect(card.getByRole("button", { name: "Copy address" })).toBeVisible();
	await expect(card.getByRole("button", { name: "New email" })).toHaveCount(0);
	await expect(card.getByRole("button", { name: /Search Inbox for mail from/ })).toHaveCount(0);
	await expect(card.getByRole("button", { name: "Block contact" })).toHaveCount(0);
});

test("on a phone the card fits the screen", async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	const chips = await openThread(page);
	const card = await openCard(page, chips.getByRole("button", { name: new RegExp(NAME) }));
	const box = (await card.boundingBox())!;
	expect(box.x).toBeGreaterThanOrEqual(0);
	expect(box.x + box.width).toBeLessThanOrEqual(390);
	expect(box.y + box.height).toBeLessThanOrEqual(844);
	await card.getByRole("button", { name: "Search Inbox for mail from Roshni at Cursor" }).click();
	await expect(page).toHaveURL(/\/inbox$/);
});

if (SHOT_DIR) {
	for (const variant of [
		{ name: "kite-light", style: "kite", theme: "light" },
		{ name: "kite-dark", style: "kite", theme: "dark" },
		{ name: "classic-light", style: "classic", theme: "light" },
		{ name: "classic-dark", style: "classic", theme: "dark" },
	]) {
		test(`screenshots (${variant.name})`, async ({ page }) => {
			mkdirSync(SHOT_DIR, { recursive: true });
			await page.setViewportSize({ width: 1440, height: 900 });
			const chips = await openThread(page, variant);
			const chip = chips.getByRole("button", { name: new RegExp(NAME) });
			// The conversation loads after the header, so the other address shows once it has.
			await expect(async () => {
				await chip.hover();
				await expect(page.getByRole("tooltip")).toContainText("also", { timeout: 1_500 });
			}).toPass({ timeout: 20_000 });
			await page.screenshot({
				path: `${SHOT_DIR}/tooltip-${variant.name}.png`,
				clip: { x: 0, y: 0, width: 1440, height: 420 },
			});
			await openCard(page, chip);
			await page.mouse.move(700, 800);
			await page.screenshot({
				path: `${SHOT_DIR}/card-${variant.name}.png`,
				clip: { x: 0, y: 0, width: 1440, height: 520 },
			});
		});
	}
}
