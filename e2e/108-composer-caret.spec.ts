import { expect, test, type Page } from "@playwright/test";
import { STORAGE_STATE } from "./support/constants";
import { apiContext, setSendingSettings, uniqueToken } from "./support/helpers";

// Typing keeps the caret where it is while something else changes attributes inside the editor, as browser extensions
// (grammar checkers, password managers) do. The editor used to rewrite its HTML whenever it differed from the value it
// had just emitted, which put the caret back at the start, so the text came out backwards (upstream Mailflare #267).

const RECIPIENT = "receiver@e2e.test";

async function openComposer(page: Page) {
	await page.goto("/inbox");
	await page.getByRole("button", { name: "Compose" }).click();
	const to = page.getByLabel("To", { exact: true });
	await to.fill(RECIPIENT);
	await to.press("Enter");
	await page.getByLabel("Subject").fill(`Caret ${uniqueToken()}`);
	return page.getByRole("textbox", { name: "Message body" });
}

test("typing keeps the caret in place while an extension adds attributes to the editor", async ({ page }) => {
	const api = await apiContext(STORAGE_STATE);
	try {
		await setSendingSettings(api, { previewEnabled: false, undoSeconds: 0 });
	} finally {
		await api.dispose();
	}
	const body = await openComposer(page);
	await body.click();
	await body.pressSequentially("First");
	await page.keyboard.press("Enter");

	// After every text change, stamp a new attribute value on each paragraph, the way an extension marks what it read.
	await body.evaluate((editor) => {
		let seen = 0;
		new MutationObserver(() => {
			seen += 1;
			for (const element of editor.querySelectorAll("div")) element.setAttribute("data-extension-seen", String(seen));
		}).observe(editor, { childList: true, characterData: true, subtree: true });
	});

	await body.pressSequentially("Hello world");
	const paragraphs = body.locator("> div");
	await expect(paragraphs.first()).toHaveText("First");
	await expect(paragraphs.last()).toHaveText("Hello world");
	expect(await paragraphs.last().getAttribute("data-extension-seen")).not.toBeNull();
});
