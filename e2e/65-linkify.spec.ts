import { expect, test, type Page } from "@playwright/test";
import { STORAGE_STATE, SUPPORT_ADDRESS } from "./support/constants";
import { apiContext, deliverInbound, setSendingSettings, uniqueToken, waitForMessage } from "./support/helpers";

// Web and email addresses in plain text are links in the reader, and a URL typed in the composer is a link
// in the message that goes out.

const REPO = "https://github.com/midego1/kite";

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

test("a received message shows plain addresses as links that open safely", async ({ page }) => {
	const api = await apiContext(STORAGE_STATE);
	const subject = `Linkify ${uniqueToken()}`;
	await deliverInbound(api, {
		from: `"Link Sender" <links@outside.test>`,
		to: SUPPORT_ADDRESS,
		subject,
		html: [
			`<p>Repo: ${REPO}.</p>`,
			"<p>Docs (www.example.com/docs) and write to hello@example.com</p>",
			'<p><a href="https://already.example/x">https://already.example/x</a></p>',
			"<p>Not a link: javascript:alert(1)</p>",
		].join(""),
	});
	await api.dispose();

	await openMessage(page, subject);
	const body = page.frameLocator('iframe[title="Message body"]');
	const repo = body.getByRole("link", { name: REPO, exact: true });
	await expect(repo).toHaveAttribute("href", REPO);
	await expect(repo).toHaveAttribute("target", "_blank");
	await expect(repo).toHaveAttribute("rel", /noopener/);
	await expect(repo).toHaveAttribute("rel", /noreferrer/);
	await expect(body.getByRole("link", { name: "www.example.com/docs" })).toHaveAttribute(
		"href",
		"https://www.example.com/docs",
	);
	await expect(body.getByRole("link", { name: "hello@example.com" })).toHaveAttribute(
		"href",
		"mailto:hello@example.com",
	);
	await expect(body.getByRole("link", { name: "https://already.example/x" })).toHaveCount(1);
	await expect(body.getByText("javascript:alert(1)")).toBeVisible();
	await expect(body.locator('a[href^="javascript:"]')).toHaveCount(0);
	// The sentence's full stop is not part of the address.
	await expect(body.locator("p").first()).toHaveText(`Repo: ${REPO}.`);
});

test("a text-only message shows its addresses as links too", async ({ page }) => {
	const api = await apiContext(STORAGE_STATE);
	const subject = `Linkify text ${uniqueToken()}`;
	await deliverInbound(api, {
		from: `"Link Sender" <links@outside.test>`,
		to: SUPPORT_ADDRESS,
		subject,
		text: `Look at ${REPO}, or (https://en.wikipedia.org/wiki/Kite_(bird)).`,
	});
	await api.dispose();

	await openMessage(page, subject);
	const main = page.getByRole("main");
	const repo = main.getByRole("link", { name: REPO, exact: true });
	await expect(repo).toHaveAttribute("href", REPO);
	await expect(repo).toHaveAttribute("target", "_blank");
	await expect(repo).toHaveAttribute("rel", "noopener noreferrer nofollow");
	await expect(main.getByRole("link", { name: "https://en.wikipedia.org/wiki/Kite_(bird)" })).toBeVisible();
});

test("a URL typed in the composer is a link in the sent message", async ({ page }) => {
	const api = await apiContext(STORAGE_STATE);
	await setSendingSettings(api, { previewEnabled: false, undoSeconds: 0 });
	const subject = `Typed link ${uniqueToken()}`;

	await page.goto("/inbox");
	await page.getByRole("button", { name: "Compose" }).click();
	const to = page.getByLabel("To", { exact: true });
	await to.fill("receiver@e2e.test");
	await to.press("Enter");
	await page.getByLabel("Subject").fill(subject);
	const editor = page.getByRole("textbox", { name: "Message body" });
	await editor.click();
	await editor.pressSequentially(`Have a look at ${REPO} and tell me.`);
	// The space after the address linked it while typing; the text after it stayed outside the link.
	const typed = editor.getByRole("link", { name: REPO, exact: true });
	await expect(typed).toHaveAttribute("href", REPO);
	await expect(editor).toContainText(`Have a look at ${REPO} and tell me.`);

	// An address typed last has no space after it: it is linked when the message is sent.
	await editor.press("Enter");
	await editor.pressSequentially("https://example.org/last");

	const sent = page.waitForResponse(
		(response) => response.url().endsWith("/api/send") && response.request().method() === "POST",
	);
	await page.getByRole("button", { name: "Send", exact: true }).click();
	expect((await sent).ok()).toBe(true);

	const stored = await waitForMessage(api, subject, { status: "sent" });
	const detail = (await (await api.get(`/api/messages/${stored.id}`)).json()) as {
		body: { htmlBody: string; textBody: string };
	};
	expect(detail.body.htmlBody).toContain(`<a href="${REPO}"`);
	expect(detail.body.htmlBody).toContain('<a href="https://example.org/last"');
	expect(detail.body.htmlBody).not.toContain(`href="${REPO} `);
	expect(detail.body.textBody).toContain(`Have a look at ${REPO} and tell me.`);
	expect(detail.body.textBody).not.toContain("<a");

	await page.goto("/sent");
	await page.getByText(subject, { exact: true }).first().click();
	const body = page.frameLocator('iframe[title="Message body"]');
	await expect(body.getByRole("link", { name: REPO, exact: true })).toHaveAttribute("href", REPO);
	await api.dispose();
});
