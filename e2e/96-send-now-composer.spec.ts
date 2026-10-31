import { expect, test, type Page } from "@playwright/test";
import { createSignedInAccount } from "./support/auto-read";
import { STORAGE_STATE, SUPPORT_ADDRESS } from "./support/constants";
import { apiContext, deliverInbound, setSendingSettings, uniqueToken, waitForMessage } from "./support/helpers";

// The undo bar while a send is held: a visible countdown, the subject as a link to the queued message in Sent, and
// Send now, which delivers once and removes the bar. Also the composer body filling its container, so a click below
// the text lands in the editor (ideas from upstream Mailflare #210 and #211, AGPL-3.0).

const RECIPIENT = "receiver@e2e.test";

async function fillComposer(page: Page, subject: string, body: string) {
	await page.getByRole("button", { name: "Compose" }).click();
	const to = page.getByLabel("To", { exact: true });
	await to.fill(RECIPIENT);
	await to.press("Enter");
	await expect(page.getByRole("button", { name: `Remove ${RECIPIENT}` })).toBeVisible();
	await page.getByLabel("Subject").fill(subject);
	await page.getByRole("textbox", { name: "Message body" }).fill(body);
}

test.describe("held send", () => {
	test.beforeEach(async () => {
		const api = await apiContext(STORAGE_STATE);
		await setSendingSettings(api, { previewEnabled: false, undoSeconds: 30 });
		await api.dispose();
	});
	test.afterEach(async () => {
		const api = await apiContext(STORAGE_STATE);
		await setSendingSettings(api, { previewEnabled: false, undoSeconds: 0 });
		await api.dispose();
	});

	test("the bar counts down and its subject opens the queued message in Sent", async ({ page }) => {
		await page.goto("/inbox");
		const subject = `Countdown ${uniqueToken()}`;
		await fillComposer(page, subject, "Held for the countdown");
		await page.getByRole("button", { name: "Send", exact: true }).click();

		const bar = page.getByRole("status").filter({ hasText: /Sending in \d+s/ });
		await expect(bar).toBeVisible();
		const seconds = async () => Number(/Sending in (\d+)s/.exec((await bar.textContent()) ?? "")?.[1]);
		const first = await seconds();
		await expect.poll(seconds, { timeout: 10_000 }).toBeLessThan(first);

		const link = bar.getByRole("link", { name: subject });
		await expect(link).toHaveAttribute("href", /^\/sent\/msg_[\w-]+$/);
		await link.click();
		await expect(page).toHaveURL(/\/sent\/msg_[\w-]+$/);
		await expect(page.getByRole("region", { name: "Sending" })).toContainText("This message is being sent.");
	});

	test("Send now delivers once and the undo bar disappears", async ({ page }) => {
		const api = await apiContext(STORAGE_STATE);
		await page.goto("/inbox");
		const subject = `Send now ${uniqueToken()}`;
		await fillComposer(page, subject, "Sent before the window ends");
		await page.getByRole("button", { name: "Send", exact: true }).click();

		const bar = page.getByRole("status").filter({ hasText: /Sending in \d+s/ });
		await expect(bar).toBeVisible();
		const queued = await waitForMessage(api, subject, { status: "sent,queued", direction: "outbound" });
		expect(queued.status).toBe("queued");

		const sendNow = page.waitForResponse(
			(response) => response.url().endsWith("/send-now") && response.request().method() === "POST",
		);
		await bar.getByRole("button", { name: "Send now" }).click();
		expect((await sendNow).ok()).toBe(true);
		await expect(bar).toBeHidden();
		await expect(page.getByText("Message sent")).toBeVisible();

		const sent = await waitForMessage(api, subject, { status: "sent" });
		expect(sent.id).toBe(queued.id);

		// A second press (another tab, a retry) neither sends again nor undoes the delivered message.
		const again = await api.post(`/api/messages/${queued.id}/send-now`);
		expect(again.status()).toBe(409);
		const undo = await api.post("/api/send/undo", { data: { messageId: queued.id } });
		expect(undo.status()).toBe(404);
		expect((await waitForMessage(api, subject, { status: "sent" })).id).toBe(queued.id);

		await page.goto("/sent");
		await expect(page.getByRole("main").getByText(subject, { exact: true })).toHaveCount(1);
		await api.dispose();
	});

	test("Send now is for the author only, and unknown ids and anonymous requests are refused", async () => {
		const api = await apiContext(STORAGE_STATE);
		const received = await deliverInbound(api, {
			from: `"Sender" <sender@outside.test>`,
			to: SUPPORT_ADDRESS,
			subject: `Author only setup ${uniqueToken()}`,
		});
		const subject = `Author only ${uniqueToken()}`;
		const sent = await api.post("/api/send", {
			data: { from: SUPPORT_ADDRESS, to: RECIPIENT, subject, text: "Held", mailboxId: received.mailboxId },
		});
		expect(sent.ok(), await sent.text()).toBe(true);
		const { messageId, undoUntil } = (await sent.json()) as { messageId: string; undoUntil?: string };
		expect(undoUntil).toBeTruthy();

		const other = await createSignedInAccount(api, `sendnow${uniqueToken("u")}`);
		expect((await other.api.post(`/api/messages/${messageId}/send-now`)).status()).toBe(404);
		expect((await waitForMessage(api, subject, { status: "queued", direction: "outbound" })).status).toBe("queued");

		expect((await api.post("/api/messages/msg_does_not_exist/send-now")).status()).toBe(404);
		const anonymous = await apiContext();
		expect((await anonymous.post(`/api/messages/${messageId}/send-now`)).status()).toBe(401);
		// The author can, once.
		expect((await api.post(`/api/messages/${messageId}/send-now`)).ok()).toBe(true);
		expect((await api.post(`/api/messages/${messageId}/send-now`)).status()).toBe(409);
		await waitForMessage(api, subject, { status: "sent" });
		await other.api.dispose();
		await anonymous.dispose();
		await api.dispose();
	});
});

test.describe("composer sizing", () => {
	async function expectBodyFillsContainer(page: Page) {
		const body = page.getByRole("textbox", { name: "Message body" });
		await expect(body).toBeVisible();
		const fills = async () =>
			body.evaluate((editor) => {
				const scroller = editor.parentElement!;
				return scroller.clientHeight - editor.getBoundingClientRect().height;
			});
		// The editable is at least as tall as its scroller, so there is no dead area under the text.
		await expect.poll(fills).toBeLessThanOrEqual(1);
		const box = (await body.boundingBox())!;
		// A click in the lower part of the body focuses the editor.
		await body.click({ position: { x: box.width / 2, y: box.height - 8 } });
		await expect(body).toBeFocused();
	}

	test("the floating composer's body fills its container", async ({ page }) => {
		await page.goto("/inbox");
		await page.getByRole("button", { name: "Compose" }).click();
		await expectBodyFillsContainer(page);
	});

	test("the full-page composer's body fills its container", async ({ page }) => {
		await page.goto("/compose");
		await expectBodyFillsContainer(page);
	});
});
