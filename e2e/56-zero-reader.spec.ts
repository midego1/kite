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
