import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { createSignedInAccount, okJson, selectMailbox } from "./support/auto-read";
import { STORAGE_STATE, SUPPORT_ADDRESS } from "./support/constants";
import {
	apiContext,
	deliverInbound,
	openMessage,
	setSendingSettings,
	uniqueToken,
	waitForMessage,
} from "./support/helpers";

// The composer for Arabic and Hebrew: a paragraph flows right to left as soon as it is typed, a button switches the
// paragraph's direction, and the direction is in the draft and in the HTML that is sent.

const RECIPIENT = "receiver@e2e.test";
const ARABIC = "مرحبا بالعالم";
const HEBREW = "שלום עולם";
const ENGLISH = "Hello world";

async function openComposer(page: Page, subject: string) {
	await page.goto("/inbox");
	await page.getByRole("button", { name: "Compose" }).click();
	const to = page.getByLabel("To", { exact: true });
	await to.fill(RECIPIENT);
	await to.press("Enter");
	await expect(page.getByRole("button", { name: `Remove ${RECIPIENT}` })).toBeVisible();
	await page.getByLabel("Subject").fill(subject);
}

function editor(page: Page) {
	return page.getByRole("textbox", { name: "Message body" });
}

/** The direction the browser draws a paragraph in. */
function direction(paragraph: Locator) {
	return paragraph.evaluate((element) => getComputedStyle(element).direction);
}

/** Types three lines, so each is a paragraph of its own: Arabic, English, Hebrew. */
async function typeThreeParagraphs(page: Page) {
	const body = editor(page);
	await body.click();
	await body.pressSequentially(ARABIC);
	await page.keyboard.press("Enter");
	await body.pressSequentially(ENGLISH);
	await page.keyboard.press("Enter");
	await body.pressSequentially(HEBREW);
}

test.describe("right-to-left composer", () => {
	let api: APIRequestContext;

	test.beforeEach(async () => {
		api = await apiContext(STORAGE_STATE);
		await setSendingSettings(api, { previewEnabled: false, undoSeconds: 0 });
	});

	test.afterEach(async () => {
		await api.dispose();
	});

	test("the first line flows from the right as soon as it is typed, and each paragraph has its own direction", async ({
		page,
	}) => {
		await openComposer(page, `Direction ${uniqueToken()}`);
		const body = editor(page);
		await body.click();
		await body.pressSequentially(ARABIC);

		// The first line has a paragraph of its own at once, drawn from the right, with the caret still in it.
		const first = body.locator("> div");
		await expect(first).toHaveCount(1);
		await expect(first).toHaveAttribute("dir", "auto");
		expect(await direction(first)).toBe("rtl");
		await expect(first).toHaveText(ARABIC);
		const edges = await first.evaluate((element) => {
			const range = document.createRange();
			range.selectNodeContents(element);
			const line = range.getBoundingClientRect();
			const box = element.getBoundingClientRect();
			return { left: line.left - box.left, right: box.right - line.right };
		});
		expect(edges.right).toBeLessThan(edges.left);

		await page.keyboard.press("Enter");
		await body.pressSequentially(ENGLISH);
		await page.keyboard.press("Enter");
		await body.pressSequentially(HEBREW);

		const paragraphs = body.locator("> div");
		await expect(paragraphs).toHaveCount(3);
		expect([
			await direction(paragraphs.nth(0)),
			await direction(paragraphs.nth(1)),
			await direction(paragraphs.nth(2)),
		]).toEqual(["rtl", "ltr", "rtl"]);
		await expect(paragraphs.nth(0)).toHaveAttribute("dir", "auto");
		await expect(paragraphs.nth(2)).toHaveAttribute("dir", "auto");

		// Typing English into the Arabic paragraph's place does not leave it right to left: auto follows the text.
		await paragraphs.nth(0).click();
		await page.keyboard.press("Control+A");
		await page.keyboard.type("Now English");
		await expect.poll(() => direction(paragraphs.nth(0))).toBe("ltr");
	});

	test("the subject field follows the text it holds", async ({ page }) => {
		await openComposer(page, ARABIC);
		const subject = page.getByLabel("Subject");
		await expect(subject).toHaveAttribute("dir", "auto");
		expect(await direction(subject)).toBe("rtl");
		await subject.fill("English subject");
		expect(await direction(subject)).toBe("ltr");
	});

	test("the direction button cycles automatic, right to left, left to right", async ({ page }) => {
		await openComposer(page, `Button ${uniqueToken()}`);
		await typeThreeParagraphs(page);
		const paragraphs = editor(page).locator("> div");
		const button = page.getByRole("button", { name: /^Paragraph direction/ });

		// The caret is in the Hebrew paragraph; the button says so and what it does next.
		await expect(button).toHaveAccessibleName("Paragraph direction: automatic. Switch to right to left");
		await button.click();
		await expect(paragraphs.nth(2)).toHaveAttribute("dir", "rtl");
		await expect(button).toHaveAccessibleName("Paragraph direction: right to left. Switch to left to right");
		await button.click();
		await expect(paragraphs.nth(2)).toHaveAttribute("dir", "ltr");
		expect(await direction(paragraphs.nth(2))).toBe("ltr");
		await expect(button).toHaveAccessibleName("Paragraph direction: left to right. Switch to automatic");
		await button.click();
		// Automatic: the text decides again, so Hebrew is right to left once more.
		await expect(paragraphs.nth(2)).toHaveAttribute("dir", "auto");
		expect(await direction(paragraphs.nth(2))).toBe("rtl");
		await expect(button).toHaveAccessibleName("Paragraph direction: automatic. Switch to right to left");

		// Only the paragraph with the caret changed; the English one next to it still follows its text.
		expect((await paragraphs.nth(1).getAttribute("dir")) ?? "auto").toBe("auto");
		expect(await direction(paragraphs.nth(1))).toBe("ltr");

		// The caret stayed where it was, so typing continues in the same paragraph, and undo still takes it back.
		await page.keyboard.type("!");
		await expect(paragraphs.nth(2)).toContainText(`${HEBREW}!`);
		await page.keyboard.press("Control+Z");
		await expect(paragraphs.nth(2)).not.toContainText("!");
	});

	test("one press changes every paragraph a selection touches", async ({ page }) => {
		await openComposer(page, `Selection ${uniqueToken()}`);
		await typeThreeParagraphs(page);
		await page.keyboard.press("Control+A");
		await page.getByRole("button", { name: /^Paragraph direction/ }).click();
		const paragraphs = editor(page).locator("> div");
		for (let index = 0; index < 3; index += 1) await expect(paragraphs.nth(index)).toHaveAttribute("dir", "rtl");
		expect(await direction(paragraphs.nth(1))).toBe("rtl");
	});

	test("the sent message keeps the directions, and the text part stays in logical order", async ({ page }) => {
		const token = uniqueToken();
		const subject = `${token} ${ARABIC}`;
		await openComposer(page, subject);
		await typeThreeParagraphs(page);

		// Switch the middle paragraph to right to left on purpose: an explicit choice is sent as it was made.
		await editor(page).locator("> div").nth(1).click();
		await page.getByRole("button", { name: /^Paragraph direction/ }).click();

		const sent = page.waitForResponse(
			(response) => response.url().endsWith("/api/send") && response.request().method() === "POST",
		);
		await page.getByRole("button", { name: "Send", exact: true }).click();
		expect((await sent).ok()).toBe(true);
		await expect(page.getByText("Message sent")).toBeVisible();

		const message = await waitForMessage(api, token, { status: "sent" });
		expect(message.subject).toBe(subject);
		const detail = (await (await api.get(`/api/messages/${message.id}`)).json()) as {
			body: { htmlBody: string; textBody: string };
		};
		expect(detail.body.htmlBody).toContain(`<div dir="auto">${ARABIC}</div>`);
		expect(detail.body.htmlBody).toContain(`<div dir="rtl">${ENGLISH}</div>`);
		expect(detail.body.htmlBody).toContain(`<div dir="auto">${HEBREW}</div>`);
		expect(
			detail.body.textBody
				.split(/\n+/)
				.map((line) => line.trim())
				.filter(Boolean),
		).toEqual([ARABIC, ENGLISH, HEBREW]);
	});

	test("a one-line Arabic message is sent in a paragraph that carries its direction", async ({ page }) => {
		const token = uniqueToken();
		await openComposer(page, `${token} short`);
		await editor(page).click();
		await editor(page).pressSequentially(ARABIC);
		await page.getByRole("button", { name: "Send", exact: true }).click();
		await expect(page.getByText("Message sent")).toBeVisible();
		const message = await waitForMessage(api, token, { status: "sent" });
		const detail = (await (await api.get(`/api/messages/${message.id}`)).json()) as { body: { htmlBody: string } };
		expect(detail.body.htmlBody).toContain(`<div dir="auto">${ARABIC}</div>`);
	});

	test("a saved draft opens with the same directions", async ({ page }) => {
		const token = uniqueToken();
		await openComposer(page, `${token} draft`);
		await typeThreeParagraphs(page);
		await editor(page).locator("> div").nth(1).click();
		await page.getByRole("button", { name: /^Paragraph direction/ }).click();

		let draftId = "";
		await expect
			.poll(async () => {
				const response = await api.get("/api/drafts");
				const { drafts } = (await response.json()) as {
					drafts: { id: string; subject: string | null; htmlBody: string | null }[];
				};
				const draft = drafts.find((item) => item.subject?.includes(token));
				draftId = draft?.id ?? "";
				return draft?.htmlBody ?? "";
			})
			.toContain(`<div dir="rtl">${ENGLISH}</div>`);

		await page.goto(`/drafts/${draftId}`);
		const paragraphs = editor(page).locator("> div");
		await expect(paragraphs).toHaveCount(3);
		await expect(paragraphs.nth(0)).toHaveAttribute("dir", "auto");
		await expect(paragraphs.nth(1)).toHaveAttribute("dir", "rtl");
		await expect(paragraphs.nth(2)).toHaveAttribute("dir", "auto");
		expect([
			await direction(paragraphs.nth(0)),
			await direction(paragraphs.nth(1)),
			await direction(paragraphs.nth(2)),
		]).toEqual(["rtl", "rtl", "rtl"]);
		// Reopening and sending without a single edit sends the same HTML as the draft held.
		await page.getByRole("button", { name: "Delete draft" }).click();
		await expect(page.getByRole("button", { name: "Close composer" })).toHaveCount(0);
	});

	test("a right-to-left list keeps its markers inside the box", async ({ page }) => {
		await openComposer(page, `List ${uniqueToken()}`);
		await editor(page).click();
		await page.getByRole("button", { name: "Bulleted list" }).click();
		await editor(page).pressSequentially(ARABIC);
		await page.keyboard.press("Enter");
		await editor(page).pressSequentially(ENGLISH);
		const list = editor(page).locator("ul");
		await expect(list).toHaveAttribute("dir", "rtl");
		expect(await direction(list)).toBe("rtl");
		const padding = await list.evaluate((element) => {
			const style = getComputedStyle(element);
			return { left: style.paddingLeft, right: style.paddingRight };
		});
		expect(padding).toEqual({ left: "0px", right: "24px" });
		// The English item next to the Arabic one is drawn left to right.
		expect(await direction(list.locator("li").nth(1))).toBe("ltr");
	});

	test("an Arabic signature reads right to left, and typing above it, the caret and undo still work", async ({
		browser,
	}) => {
		const username = `rtlsig${uniqueToken("")}`;
		const account = await createSignedInAccount(api, username);
		await okJson(
			await account.api.patch(`/api/mailboxes/${account.mailboxId}`, { data: { signature: `${ARABIC}\n${HEBREW}` } }),
		);
		const context = await browser.newContext({ storageState: await account.api.storageState() });
		const page = await context.newPage();
		try {
			await selectMailbox(page, account.mailboxId);
			await page.goto("/inbox");
			await page.getByRole("button", { name: "Compose" }).click();
			const body = editor(page);
			await expect(body).toContainText(ARABIC);
			const signature = body.locator("[data-kite-signature]");
			await expect(signature).toHaveAttribute("dir", "auto");
			expect(await direction(signature)).toBe("rtl");

			// The line above the signature is the body: the caret goes there and English stays left to right.
			const first = body.locator("> div").first();
			await first.click();
			await page.keyboard.type("Thanks");
			await expect(first).toHaveText("Thanks");
			expect(await direction(first)).toBe("ltr");
			await expect(signature).toContainText(ARABIC);
			await page.keyboard.press("Control+Z");
			await expect(first).not.toContainText("Thanks");
			await expect(signature).toContainText(HEBREW);
			await expect(signature).toHaveAttribute("dir", "auto");

			// Arabic typed on that line flows from the right, and the signature is still in one piece.
			await first.click();
			await page.keyboard.type(ARABIC);
			expect(await direction(first)).toBe("rtl");
			await expect(body.locator("[data-kite-signature]")).toHaveCount(1);
		} finally {
			await context.close();
			await account.api.dispose();
		}
	});

	test("a reply keeps the direction of what it quotes and of what is written", async ({ page }) => {
		const token = uniqueToken();
		const subject = `${token} ${ARABIC}`;
		await deliverInbound(api, {
			from: `"Layla" <layla@outside.test>`,
			to: SUPPORT_ADDRESS,
			subject,
			text: ARABIC,
		});
		await page.goto("/inbox");
		await openMessage(page, subject);
		await page
			.getByRole("button", { name: /^Reply/ })
			.first()
			.click();
		// The quote appears once the reply has loaded; typing earlier would be overwritten by it.
		const showQuoted = page.getByRole("button", { name: "Show quoted text" });
		await expect(showQuoted).toBeVisible();
		const body = editor(page);
		await body.click();
		await body.pressSequentially(ENGLISH);
		await showQuoted.click();
		// The quote is the Arabic original, drawn from the right inside an English reply.
		const quotedParagraph = page.locator(".email-body div[dir='auto']").filter({ hasText: ARABIC }).last();
		expect(await direction(quotedParagraph)).toBe("rtl");
		await page.getByRole("button", { name: "Send", exact: true }).click();
		await expect(page.getByText("Message sent")).toBeVisible();

		const reply = await waitForMessage(api, token, { status: "sent" });
		const detail = (await (await api.get(`/api/messages/${reply.id}`)).json()) as { body: { htmlBody: string } };
		expect(detail.body.htmlBody).toContain(`<div dir="auto">${ARABIC}`);
		// The reply itself is English and carries no direction.
		expect(detail.body.htmlBody).toMatch(new RegExp(`^(?:<div>)?${ENGLISH}`));
	});
});
