import { readFileSync } from "node:fs";
import { expect, test, type APIResponse, type Page } from "@playwright/test";
import { STORAGE_STATE, SUPPORT_ADDRESS } from "./support/constants";
import { apiContext, deliverInbound, uniqueToken } from "./support/helpers";

// "Download all" in the reader (ported from upstream Mailflare #269): one streamed ZIP of a message's attachments,
// gated like a single download when a file is flagged.

type Detail = { attachments: { id: string; filename: string }[] };

async function json<T>(response: APIResponse): Promise<T> {
	expect(response.ok(), `${response.url()} -> ${response.status()} ${await response.text()}`).toBe(true);
	return (await response.json()) as T;
}

/** Opens a message in the reader and waits until the startup overlay has faded, so clicks reach the page. */
async function openReader(page: Page, messageId: string) {
	await page.goto(`/inbox/${messageId}`);
	await expect(page.locator("[data-loading-overlay]")).not.toHaveClass(/opacity-100/, { timeout: 60_000 });
}

/** The names in a ZIP's central directory. */
function zipNames(bytes: Buffer): string[] {
	const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
	expect(end, "end of central directory").toBeGreaterThanOrEqual(0);
	const count = bytes.readUInt16LE(end + 10);
	let at = bytes.readUInt32LE(end + 16);
	const names: string[] = [];
	for (let index = 0; index < count; index += 1) {
		expect(bytes.readUInt32LE(at)).toBe(0x02014b50);
		const nameLength = bytes.readUInt16LE(at + 28);
		names.push(bytes.subarray(at + 46, at + 46 + nameLength).toString("utf8"));
		at += 46 + nameLength + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32);
	}
	return names;
}

test("Download all saves one ZIP of the message's attachments", async ({ browser }) => {
	const api = await apiContext(STORAGE_STATE);
	const subject = `Board pack ${uniqueToken("zip")}`;
	const message = await deliverInbound(api, {
		from: "Priya <priya@outside.test>",
		to: SUPPORT_ADDRESS,
		subject,
		text: "The board pack is attached.",
		attachments: [
			{ filename: "slides.pdf", contentType: "application/pdf", content: "%PDF-1.7 slides" },
			{ filename: "slides.pdf", contentType: "application/pdf", content: "%PDF-1.7 other slides" },
			{ filename: "minutes.txt", contentType: "text/plain", content: "Minutes" },
		],
	});
	const context = await browser.newContext({ storageState: STORAGE_STATE, acceptDownloads: true });
	const page = await context.newPage();
	try {
		await openReader(page, message.id);
		await expect(page.getByRole("heading", { level: 2, name: "Attachments (3)" })).toBeVisible();
		const [download] = await Promise.all([
			page.waitForEvent("download"),
			page.getByRole("button", { name: "Download all" }).click(),
		]);
		expect(download.suggestedFilename()).toBe(`${subject}.zip`);
		expect(await download.failure()).toBeNull();
		expect(zipNames(readFileSync(await download.path()))).toEqual(["slides.pdf", "slides (2).pdf", "minutes.txt"]);
	} finally {
		await context.close();
		await api.dispose();
	}
});

test("Download all asks before zipping a flagged file, and the server refuses without the acknowledgement", async ({
	browser,
}) => {
	const api = await apiContext(STORAGE_STATE);
	const subject = `Installer ${uniqueToken("zip")}`;
	const message = await deliverInbound(api, {
		from: "Tom <tom@outside.test>",
		to: SUPPORT_ADDRESS,
		subject,
		text: "The installer and my notes.",
		attachments: [
			{ filename: "setup.exe", contentType: "application/octet-stream", content: "MZ not really a program" },
			{ filename: "notes.txt", contentType: "text/plain", content: "Notes" },
		],
	});
	const route = `/api/messages/${message.id}/attachments/zip`;
	const refused = await api.get(route);
	expect(refused.status()).toBe(409);
	const body = (await refused.json()) as { code: string; flagged: { filename: string; risk: { level: string } }[] };
	expect(body.code).toBe("ATTACHMENT_RISK");
	expect(body.flagged.map((file) => [file.filename, file.risk.level])).toEqual([["setup.exe", "danger"]]);
	expect((await api.get(`${route}?check=1&acknowledge=1`)).status()).toBe(200);
	const allowed = await api.get(`${route}?acknowledge=1`);
	expect(allowed.status()).toBe(200);
	expect(allowed.headers()["content-type"]).toBe("application/zip");
	expect(zipNames(await allowed.body())).toEqual(["setup.exe", "notes.txt"]);

	const context = await browser.newContext({ storageState: STORAGE_STATE, acceptDownloads: true });
	const page = await context.newPage();
	try {
		await openReader(page, message.id);
		const button = page.getByRole("button", { name: "Download all" });
		await button.click();
		const dialog = page.getByRole("alertdialog", { name: "Download flagged files?" });
		await expect(dialog).toContainText("1 file is flagged as risky");
		await expect(dialog).toContainText("setup.exe");
		await dialog.getByRole("button", { name: "Cancel" }).click();
		await expect(dialog).toBeHidden();

		await button.click();
		const [download] = await Promise.all([
			page.waitForEvent("download"),
			page.getByRole("alertdialog").getByRole("button", { name: "Download all" }).click(),
		]);
		expect(download.url()).toContain("acknowledge=1");
		expect(await download.failure()).toBeNull();
	} finally {
		await context.close();
		await api.dispose();
	}
});

test("Download all is offered only from two attachments, and only to readers of the message", async ({ page }) => {
	const api = await apiContext(STORAGE_STATE);
	const subject = `One file ${uniqueToken("zip")}`;
	const message = await deliverInbound(api, {
		from: "Ana <ana@outside.test>",
		to: SUPPORT_ADDRESS,
		subject,
		text: "One file.",
		attachments: [{ filename: "only.txt", contentType: "text/plain", content: "Only" }],
	});
	try {
		await openReader(page, message.id);
		await expect(page.getByRole("heading", { level: 2, name: "Attachments (1)" })).toBeVisible();
		await expect(page.getByRole("button", { name: "Download all" })).toHaveCount(0);
		// The route still zips a single file for whoever may read it.
		const { attachments } = await json<Detail>(await api.get(`/api/messages/${message.id}`));
		expect(attachments).toHaveLength(1);
		expect(await json<{ count: number }>(await api.get(`/api/messages/${message.id}/attachments/zip?check=1`))).toEqual(
			{
				count: 1,
			},
		);
		const anonymous = await apiContext();
		expect((await anonymous.get(`/api/messages/${message.id}/attachments/zip`)).status()).toBe(401);
		await anonymous.dispose();
		expect((await api.get("/api/messages/not-a-message/attachments/zip")).status()).toBe(404);
	} finally {
		await api.dispose();
	}
});
