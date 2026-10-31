import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { STORAGE_STATE, SUPPORT_ADDRESS } from "./support/constants";
import { apiContext, deliverInbound, openMessage, uniqueToken } from "./support/helpers";

// Print renders a clean document in a hidden, sandboxed frame and calls print() on it; Download PDF saves a text PDF
// named after the subject. print() is stubbed in every frame (init scripts also run in the print frame), so a test
// counts the calls instead of opening a dialog.

async function stubPrint(page: Page) {
	await page.addInitScript(() => {
		window.print = () => {
			const top = window.top as Window & { __kitePrints?: number };
			top.__kitePrints = (top.__kitePrints ?? 0) + 1;
		};
	});
}

const printCount = (page: Page) =>
	page.evaluate(() => (window as Window & { __kitePrints?: number }).__kitePrints ?? 0);

async function openMoreActions(page: Page) {
	// The reader's toolbar menu, not the per-message menu under the header.
	await page.getByRole("main").getByRole("button", { name: "More actions" }).first().click();
	return page.getByRole("dialog", { name: "More actions" });
}

test("Print shows the message's headers, attachments and sanitized body without the app", async ({ page }) => {
	await stubPrint(page);
	const api = await apiContext(STORAGE_STATE);
	const subject = `Print me <${uniqueToken()}>`;
	await deliverInbound(api, {
		from: `"Print Sender" <printer@outside.test>`,
		to: SUPPORT_ADDRESS,
		headers: { Cc: "colleague@outside.test" },
		subject,
		text: null,
		html: `<p>Printable body for ${subject.replace(/[<>]/g, "")}</p><script>window.top.__kiteScript = 1</script><img src="http://127.0.0.1:9/tracker.png" alt="tracker"><blockquote><p>Quoted history line</p></blockquote>`,
		attachments: [{ filename: "notes.txt", contentType: "text/plain", content: "x".repeat(2000) }],
	});
	await api.dispose();

	const tracker: string[] = [];
	page.on("request", (request) => {
		if (request.url().includes("tracker.png")) tracker.push(request.url());
	});
	await page.goto("/inbox");
	await openMessage(page, subject);
	const menu = await openMoreActions(page);
	await menu.getByRole("button", { name: "Print", exact: true }).click();
	await expect.poll(() => printCount(page)).toBe(1);

	const frame = page.frameLocator("#kite-print-frame");
	await expect(frame.locator("h1")).toHaveText(subject);
	await expect(frame.locator(".print-headers")).toContainText("From");
	await expect(frame.locator(".print-headers")).toContainText("Print Sender <printer@outside.test>");
	await expect(frame.locator(".print-headers")).toContainText("Cc");
	await expect(frame.locator(".print-headers")).toContainText("colleague@outside.test");
	await expect(frame.locator(".print-attachments")).toContainText("notes.txt (2 KB)");
	await expect(frame.locator(".print-body")).toContainText("Printable body for");
	// The quoted history is printed open, and nothing of the app's chrome is in the document.
	await expect(frame.locator(".print-body blockquote")).toContainText("Quoted history line");
	await expect(frame.locator("details")).toHaveCount(0);
	await expect(frame.locator("nav, aside, button")).toHaveCount(0);
	// Remote images stay blocked as in the reader, and no script from the mail ran.
	await expect(frame.locator("img")).toHaveCount(0);
	expect(tracker).toEqual([]);
	expect(await page.evaluate(() => (window as Window & { __kiteScript?: number }).__kiteScript)).toBeUndefined();
	await expect(page.locator("#kite-print-frame")).toHaveAttribute("sandbox", "allow-same-origin allow-modals");

	// Ctrl+P in the reader prints the message, not the page around it.
	await page.getByRole("heading", { level: 1, name: subject }).click();
	await page.keyboard.press("Control+p");
	await expect.poll(() => printCount(page)).toBe(2);
});

test("Print conversation prints every message of the thread, oldest first", async ({ page }) => {
	await stubPrint(page);
	const api = await apiContext(STORAGE_STATE);
	const token = uniqueToken();
	const originalId = `<${token}@outside.test>`;
	await deliverInbound(api, {
		from: `"Thread Printer" <thread@outside.test>`,
		to: SUPPORT_ADDRESS,
		subject: `Print plan ${token}`,
		text: `First printed message ${token}`,
		messageId: originalId,
	});
	await deliverInbound(api, {
		from: `"Thread Printer" <thread@outside.test>`,
		to: SUPPORT_ADDRESS,
		subject: `Re: Print plan ${token}`,
		text: `Second printed message ${token}`,
		inReplyTo: originalId,
	});
	await api.dispose();

	await page.goto("/inbox");
	await openMessage(page, `Re: Print plan ${token}`);
	await expect(page.getByRole("region", { name: "Earlier messages in this conversation" })).toBeVisible();
	const menu = await openMoreActions(page);
	await menu.getByRole("button", { name: "Print conversation" }).click();
	await expect.poll(() => printCount(page)).toBe(1);

	const frame = page.frameLocator("#kite-print-frame");
	await expect(frame.locator("h1")).toHaveText(`Print plan ${token}`);
	await expect(frame.locator(".print-count")).toHaveText("2 messages in this conversation");
	await expect(frame.locator("article.print-message")).toHaveCount(2);
	await expect(frame.locator("article.print-message").nth(0)).toContainText(`First printed message ${token}`);
	await expect(frame.locator("article.print-message").nth(1)).toContainText(`Second printed message ${token}`);
	await expect(frame.locator("article.print-message").nth(1).locator("h2")).toHaveText(`Re: Print plan ${token}`);
});

test("Print conversation shows an earlier message's remote images only after Show images on it", async ({ page }) => {
	await stubPrint(page);
	const api = await apiContext(STORAGE_STATE);
	const token = uniqueToken();
	const originalId = `<${token}@outside.test>`;
	const imageUrl = `https://images.outside.test/pixel.png?print=${token}`;
	const first = await deliverInbound(api, {
		from: `"Image Thread" <images@outside.test>`,
		to: SUPPORT_ADDRESS,
		subject: `Print images ${token}`,
		text: null,
		html: `<p>Earlier with an image ${token}</p><img src="${imageUrl}" alt="remote pixel">`,
		messageId: originalId,
	});
	await deliverInbound(api, {
		from: `"Image Thread" <images@outside.test>`,
		to: SUPPORT_ADDRESS,
		subject: `Re: Print images ${token}`,
		text: `Later without images ${token}`,
		inReplyTo: originalId,
	});
	await api.dispose();

	await page.goto("/inbox");
	await openMessage(page, `Re: Print images ${token}`);
	const earlier = page.getByRole("region", { name: "Earlier messages in this conversation" });
	await earlier.getByRole("button", { name: /Image Thread/ }).click();
	await expect(earlier.getByRole("button", { name: "Show images" })).toBeVisible();

	const frame = page.frameLocator("#kite-print-frame");
	await (await openMoreActions(page)).getByRole("button", { name: "Print conversation" }).click();
	await expect.poll(() => printCount(page)).toBe(1);
	await expect(frame.locator("article.print-message").nth(0)).toContainText(`Earlier with an image ${token}`);
	await expect(frame.locator("img")).toHaveCount(0);

	await earlier.getByRole("button", { name: "Show images" }).click();
	await (await openMoreActions(page)).getByRole("button", { name: "Print conversation" }).click();
	await expect.poll(() => printCount(page)).toBe(2);
	const image = frame.locator("article.print-message").nth(0).locator("img");
	await expect(image).toHaveCount(1);
	await expect(image).toHaveAttribute(
		"src",
		`/api/remote-images?${new URLSearchParams({ message: first.id, url: imageUrl })}`,
	);
});

test("Download PDF saves a PDF named after the subject", async ({ page }) => {
	const api = await apiContext(STORAGE_STATE);
	const token = uniqueToken();
	const subject = `Invoice: October/${token}`;
	await deliverInbound(api, {
		from: `"Billing" <billing@outside.test>`,
		to: SUPPORT_ADDRESS,
		subject,
		text: `Amount due: €42 for ${token}.\n\n> Earlier note`,
	});
	await api.dispose();

	await page.goto("/inbox");
	await openMessage(page, subject);
	const menu = await openMoreActions(page);
	const downloadPromise = page.waitForEvent("download");
	await menu.getByRole("button", { name: "Download PDF" }).click();
	const download = await downloadPromise;
	expect(download.suggestedFilename()).toBe(`Invoice October ${token}.pdf`);
	const bytes = await readFile((await download.path())!);
	expect(bytes.length).toBeGreaterThan(500);
	const text = bytes.toString("latin1");
	expect(text.startsWith("%PDF-1.4")).toBe(true);
	expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
	expect(text).toContain(`(Invoice: October/${token}) Tj`);
	expect(text).toContain(`(Amount due: \\20042 for ${token}.) Tj`);
	expect(text).toContain("(From: Billing <billing@outside.test>) Tj");
});
