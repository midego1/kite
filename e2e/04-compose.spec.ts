import { expect, test, type Page } from "@playwright/test";
import { STORAGE_STATE } from "./support/constants";
import { apiContext, setSendingSettings, uniqueToken, waitForMessage } from "./support/helpers";

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

test.describe("compose and send", () => {
	test.afterEach(async () => {
		const api = await apiContext(STORAGE_STATE);
		await setSendingSettings(api, { previewEnabled: false, undoSeconds: 0 });
		await api.dispose();
	});

	test("previews before sending, can be undone, and then sends", async ({ page }) => {
		await page.goto("/settings/inbox");
		const preview = page.getByRole("switch", { name: "Preview before sending" });
		await expect(preview).toBeVisible();
		if ((await preview.getAttribute("aria-checked")) !== "true") await preview.click();
		await expect(preview).toHaveAttribute("aria-checked", "true");
		const settingsSaved = page.waitForResponse(
			(response) => response.url().endsWith("/api/settings/sending") && response.request().method() === "PATCH",
		);
		await page.getByRole("combobox", { name: "Undo send window" }).selectOption({ label: "10 seconds" });
		expect((await settingsSaved).ok()).toBe(true);

		await page.goto("/inbox");
		const subject = `Preview ${uniqueToken()}`;
		await fillComposer(page, subject, "Hello from the preview test");

		await page.getByRole("button", { name: "Review send" }).click();
		const dialog = page.getByRole("dialog", { name: "Preview email before sending" });
		await expect(dialog).toBeVisible();
		await expect(dialog.getByText(RECIPIENT)).toBeVisible();
		await expect(dialog.getByText(subject)).toBeVisible();
		await expect(
			dialog.frameLocator('iframe[title="Message preview"]').getByText("Hello from the preview test"),
		).toBeVisible();

		await dialog.getByRole("button", { name: "Confirm and send" }).click();
		const undoBar = page.getByRole("status").filter({ hasText: /Sending in \d+s/ });
		await expect(undoBar).toBeVisible();
		await undoBar.getByRole("button", { name: "Undo" }).click();
		await expect(page.getByText("Sending undone")).toBeVisible();

		// The composer comes back with the held message.
		await expect(page.getByLabel("Subject")).toHaveValue(subject);
		await expect(page.getByRole("button", { name: `Remove ${RECIPIENT}` })).toBeVisible();

		await page.getByRole("button", { name: "Review send" }).click();
		await expect(dialog).toBeVisible();
		await dialog.getByRole("button", { name: "Confirm and send" }).click();
		await expect(undoBar).toBeVisible();
		await expect(undoBar).toBeHidden({ timeout: 20_000 });

		const api = await apiContext(STORAGE_STATE);
		await waitForMessage(api, subject, { status: "sent" });
		await api.dispose();
		await page
			.getByRole("navigation")
			.first()
			.getByRole("link", { name: /^Sent\b/ })
			.click();
		await expect(page).toHaveURL(/\/sent$/);
		await expect(page.getByRole("main").getByText(subject, { exact: true })).toBeVisible();
		// The undone attempt must not have gone out as well.
		await expect(page.getByRole("main").getByText(subject, { exact: true })).toHaveCount(1);
	});

	test("sends straight away when the preview is off", async ({ page }) => {
		const api = await apiContext(STORAGE_STATE);
		await setSendingSettings(api, { previewEnabled: false, undoSeconds: 0 });

		await page.goto("/inbox");
		const subject = `Direct ${uniqueToken()}`;
		await fillComposer(page, subject, "Sent without a preview");
		await expect(page.getByRole("button", { name: "Review send" })).toHaveCount(0);
		const sent = page.waitForResponse(
			(response) => response.url().endsWith("/api/send") && response.request().method() === "POST",
		);
		await page.getByRole("button", { name: "Send", exact: true }).click();
		expect((await sent).ok()).toBe(true);
		await expect(page.getByRole("dialog", { name: "Preview email before sending" })).toHaveCount(0);
		await expect(page.getByText("Message sent")).toBeVisible();

		await waitForMessage(api, subject, { status: "sent" });
		await api.dispose();
		await page.goto("/sent");
		await expect(page.getByRole("main").getByText(subject, { exact: true })).toBeVisible();
	});
});

test("opening the assistant chat window minimizes the composer beside it", async ({ page }) => {
	const api = await apiContext(STORAGE_STATE);
	const before = (await (await api.get("/api/admin/agent")).json()) as { assistantEnabled: boolean };
	expect((await api.put("/api/admin/agent", { data: { enabled: true } })).ok()).toBe(true);
	try {
		await page.addInitScript(() => localStorage.setItem("kite-assistant-layout", "floating"));
		await page.goto("/inbox");
		const toggle = page.getByRole("button", { name: /^(Open|Close) email assistant$/ });
		await expect(toggle).toBeVisible();
		if ((await toggle.getAttribute("aria-expanded")) === "true") await toggle.click();
		const open = page.getByRole("button", { name: "Open email assistant" });
		await expect(open).toBeVisible();

		await page.getByRole("button", { name: "Compose" }).click();
		const subject = page.getByLabel("Subject");
		await subject.fill("Kept while minimized");

		await open.click();
		const restore = page.getByRole("button", { name: "Restore composer" });
		await expect(restore).toBeVisible();
		await expect(subject).toBeHidden();
		const panel = page.locator("#email-assistant-panel");
		await expect(panel).toBeVisible();

		const composer = page.locator("form").filter({ has: page.getByRole("button", { name: "Close composer" }) });
		const besideAssistant = async () => {
			const composerBox = await composer.boundingBox();
			const assistantBox = await panel.boundingBox();
			if (!composerBox || !assistantBox) throw new Error("Composer or assistant has no box");
			return composerBox.x + composerBox.width <= assistantBox.x;
		};
		expect(await besideAssistant()).toBe(true);

		// Restored, it sits next to the assistant rather than under it.
		await restore.click();
		await expect(subject).toHaveValue("Kept while minimized");
		expect(await besideAssistant()).toBe(true);
		await page.getByRole("button", { name: "Close composer" }).click();
	} finally {
		await api.put("/api/admin/agent", { data: { enabled: before.assistantEnabled } });
		await api.dispose();
	}
});
