import { expect, test, type Browser, type Page } from "@playwright/test";
import { STORAGE_STATE, SUPPORT_ADDRESS } from "./support/constants";
import { apiContext, deliverInbound, uniqueToken } from "./support/helpers";

// A paperclip beside the date of rows that have a real attachment, in the stacked and the wide row at every
// density, light and dark. A conversation row shows it when any message of the conversation has one; an image
// that is only embedded in the body does not count.

const token = uniqueToken("clip");
const subjects = {
	withFile: `Invoice ${token}`,
	plain: `Plain ${token}`,
	inlineOnly: `Newsletter ${token}`,
	threadRoot: `Plan ${token}`,
	threadReply: `Re: Plan ${token}`,
};
const PDF = { filename: "invoice.pdf", contentType: "application/pdf", content: "%PDF-1.4 e2e" };

test.beforeAll(async () => {
	const api = await apiContext(STORAGE_STATE);
	const from = `"Clip Sender" <clip-${token}@outside.test>`;
	await deliverInbound(api, { from, to: SUPPORT_ADDRESS, subject: subjects.withFile, attachments: [PDF] });
	await deliverInbound(api, { from, to: SUPPORT_ADDRESS, subject: subjects.plain });
	await deliverInbound(api, {
		from,
		to: SUPPORT_ADDRESS,
		subject: subjects.inlineOnly,
		html: `<p>Logo <img src="cid:logo@e2e"></p>`,
		attachments: [{ filename: "logo.png", contentType: "image/png", content: "png", disposition: "inline" }],
	});
	// The attachment is on the older message; the newest message of the conversation has none.
	const root = await deliverInbound(api, {
		from,
		to: SUPPORT_ADDRESS,
		subject: subjects.threadRoot,
		messageId: `<root-${token}@e2e.test>`,
		attachments: [PDF],
	});
	expect(root.id).toBeTruthy();
	await deliverInbound(api, {
		from,
		to: SUPPORT_ADDRESS,
		subject: subjects.threadReply,
		inReplyTo: `<root-${token}@e2e.test>`,
	});
	await api.dispose();
});

async function openInbox(
	browser: Browser,
	{ pane, density, theme, conversations }: { pane: string; density: string; theme: string; conversations: boolean },
) {
	const context = await browser.newContext({ storageState: STORAGE_STATE, viewport: { width: 1400, height: 900 } });
	const page = await context.newPage();
	await page.addInitScript(
		({ pane, density, theme, conversations }) => {
			localStorage.setItem("kite-reading-pane", pane);
			localStorage.setItem("kite-message-density", density);
			localStorage.setItem("kite-theme", theme);
			localStorage.setItem("kite-conversation-view", conversations ? "on" : "off");
		},
		{ pane, density, theme, conversations },
	);
	await page.goto("/inbox");
	await expect(page.locator("html")).toHaveClass(new RegExp(`\\b${theme}\\b`));
	await expect(rowOf(page, subjects.plain)).toBeVisible({ timeout: 60_000 });
	await expect(page.locator("[data-loading-overlay]")).toHaveCSS("opacity", "0");
	return { page, context };
}

const rowOf = (page: Page, subject: string) => page.locator("[data-message-row]").filter({ hasText: subject }).first();
const clipOf = (page: Page, subject: string) => rowOf(page, subject).locator("[data-attachment-indicator]");

for (const pane of ["right", "none"]) {
	for (const density of ["default", "comfortable", "compact"]) {
		for (const theme of density === "default" ? ["light", "dark"] : ["light"]) {
			test(`the paperclip shows only on rows with an attachment: ${pane} pane, ${density}, ${theme}`, async ({
				browser,
			}, testInfo) => {
				const { page, context } = await openInbox(browser, { pane, density, theme, conversations: false });
				const clip = clipOf(page, subjects.withFile);
				await expect(clip).toHaveCount(1);
				await expect(clip).toBeVisible();
				await expect(clip).toHaveText("Has attachments");
				await expect(clip).toHaveAttribute("title", "Has attachments");
				await expect(clipOf(page, subjects.plain)).toHaveCount(0);
				await expect(clipOf(page, subjects.inlineOnly)).toHaveCount(0);
				// It sits on the date's line, left of the date, inside the row.
				const rowBox = (await rowOf(page, subjects.withFile).boundingBox())!;
				const clipBox = (await clip.locator("svg").boundingBox())!;
				const dateBox = (await rowOf(page, subjects.withFile).locator("time").boundingBox())!;
				expect(clipBox.x + clipBox.width).toBeLessThanOrEqual(dateBox.x + 1);
				expect(clipBox.x).toBeGreaterThanOrEqual(rowBox.x);
				expect(Math.abs(clipBox.y + clipBox.height / 2 - (dateBox.y + dateBox.height / 2))).toBeLessThan(8);
				await rowOf(page, subjects.withFile).screenshot({
					path: testInfo.outputPath(`attachment-icon-${pane}-${density}-${theme}.png`),
				});
				await context.close();
			});
		}
	}
}

test("a conversation row shows the paperclip when an older message has the attachment", async ({ browser }) => {
	const { page, context } = await openInbox(browser, {
		pane: "right",
		density: "default",
		theme: "light",
		conversations: true,
	});
	// One row for the conversation, represented by the newest message, which has no attachment itself.
	await expect(page.locator("[data-message-row]").filter({ hasText: subjects.threadReply })).toHaveCount(1);
	await expect(clipOf(page, subjects.threadReply)).toHaveCount(1);
	await expect(clipOf(page, subjects.plain)).toHaveCount(0);
	await context.close();
});

test("the list API reports hasAttachments on single and conversation rows", async () => {
	const api = await apiContext(STORAGE_STATE);
	for (const group of ["", "&group=thread"]) {
		const response = await api.get(`/api/messages?q=${token}&status=received&limit=50${group}`);
		expect(response.ok()).toBe(true);
		const { messages } = (await response.json()) as { messages: { subject: string; hasAttachments: boolean }[] };
		const flag = (subject: string) => messages.find((message) => message.subject === subject)?.hasAttachments;
		expect(flag(subjects.withFile), group).toBe(true);
		expect(flag(subjects.plain), group).toBe(false);
		expect(flag(subjects.inlineOnly), group).toBe(false);
		if (group) expect(flag(subjects.threadReply), group).toBe(true);
	}
	await api.dispose();
});
