import { expect, test, type APIRequestContext, type APIResponse } from "@playwright/test";
import { STORAGE_STATE, SUPPORT_ADDRESS } from "./support/constants";
import { apiContext, deliverInbound, uniqueToken } from "./support/helpers";

type Detail = { attachments: { id: string; filename: string }[] };
type Risk = { level: "ok" | "warning" | "danger"; reasons: string[] };

/** A minimal ZIP holding `names`: only the central directory and its end record, which is all Kite reads. */
function zipOf(names: string[]): Buffer {
	const entries = names.map((name) => {
		const nameBytes = Buffer.from(name);
		const entry = Buffer.alloc(46 + nameBytes.length);
		entry.writeUInt32LE(0x02014b50, 0);
		entry.writeUInt16LE(nameBytes.length, 28);
		nameBytes.copy(entry, 46);
		return entry;
	});
	const directory = Buffer.concat(entries);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(names.length, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(0, 16);
	return Buffer.concat([directory, end]);
}

async function json<T>(response: APIResponse): Promise<T> {
	expect(response.ok(), `${response.url()} -> ${response.status()} ${await response.text()}`).toBe(true);
	return (await response.json()) as T;
}

async function deliverWithAttachments(api: APIRequestContext, subject: string) {
	const message = await deliverInbound(api, {
		from: "Billing <billing@outside.test>",
		to: SUPPORT_ADDRESS,
		subject,
		text: "Your invoice is attached.",
		attachments: [
			{ filename: "invoice.pdf.exe", contentType: "application/octet-stream", content: "MZ not really a program" },
			{ filename: "invoice.zip", contentType: "application/zip", content: zipOf(["readme.txt", "bin/setup.exe"]) },
			{ filename: "notes.txt", contentType: "text/plain", content: "Plain notes." },
			{ filename: "setup.exe", contentType: "image/png", disposition: "inline", content: "MZ claims to be a PNG" },
		],
	});
	const { attachments } = await json<Detail>(await api.get(`/api/messages/${message.id}`));
	const idOf = (filename: string) => {
		const attachment = attachments.find((item) => item.filename === filename);
		expect(attachment, filename).toBeDefined();
		return attachment!.id;
	};
	return { message, idOf };
}

test("a flagged attachment is refused by the server until the warning is acknowledged", async () => {
	const api = await apiContext(STORAGE_STATE);
	const { message, idOf } = await deliverWithAttachments(api, `Risky attachments API ${uniqueToken("risk")}`);
	const route = (filename: string) => `/api/messages/${message.id}/attachments/${idOf(filename)}`;

	await test.step("a program with a decoy extension is dangerous and its download answers 409", async () => {
		const refused = await api.get(`${route("invoice.pdf.exe")}?download=1`);
		expect(refused.status()).toBe(409);
		const body = (await refused.json()) as { code: string; risk: Risk };
		expect(body.code).toBe("ATTACHMENT_RISK");
		expect(body.risk.level).toBe("danger");
		expect(body.risk.reasons.join(" ")).toContain("two extensions");
		const risk = await json<Risk>(await api.get(`${route("invoice.pdf.exe")}?risk=1`));
		expect(risk.level).toBe("danger");
		const allowed = await api.get(`${route("invoice.pdf.exe")}?download=1&acknowledge=1`);
		expect(allowed.status()).toBe(200);
		expect(await allowed.text()).toBe("MZ not really a program");
	});

	await test.step("a ZIP holding a program is flagged from its directory", async () => {
		const risk = await json<Risk>(await api.get(`${route("invoice.zip")}?risk=1`));
		expect(risk.level).toBe("danger");
		expect(risk.reasons.some((reason) => reason.includes("bin/setup.exe"))).toBe(true);
		expect((await api.get(route("invoice.zip"))).status()).toBe(409);
	});

	await test.step("a program declared as an inline image is gated and never rendered inline", async () => {
		expect((await api.get(route("setup.exe"))).status()).toBe(409);
		expect((await api.get(`${route("setup.exe")}?preview=1`)).status()).toBe(409);
		const allowed = await api.get(`${route("setup.exe")}?preview=1&acknowledge=1`);
		expect(allowed.status()).toBe(200);
		expect(allowed.headers()["content-disposition"]).toMatch(/^attachment;/);
	});

	await test.step("a plain file is not gated", async () => {
		expect((await json<Risk>(await api.get(`${route("notes.txt")}?risk=1`))).level).toBe("ok");
		expect((await api.get(`${route("notes.txt")}?download=1`)).status()).toBe(200);
	});

	await test.step("Save to Drive needs the same acknowledgement", async () => {
		const save = `/api/drive/attachments/${idOf("invoice.pdf.exe")}/save`;
		const refused = await api.post(save, { data: { parentId: null } });
		expect(refused.status()).toBe(409);
		expect(((await refused.json()) as { code: string }).code).toBe("ATTACHMENT_RISK");
		const content = `/api/drive/attachments/${idOf("invoice.pdf.exe")}/content?disposition=attachment`;
		expect((await api.get(content)).status()).toBe(409);
		const { item } = await json<{ item: { id: string } }>(
			await api.post(save, { data: { parentId: null, acknowledge: true } }),
		);
		await json(await api.post("/api/drive/items/bulk", { data: { ids: [item.id], action: "trash" } }));
		await json(await api.post("/api/drive/items/bulk", { data: { ids: [item.id], action: "delete" } }));
	});

	await api.dispose();
});

test("the reader warns about a flagged attachment and downloads it only after I understand the risk", async ({
	browser,
}) => {
	const api = await apiContext(STORAGE_STATE);
	const subject = `Risky attachments reader ${uniqueToken("risk")}`;
	const { message } = await deliverWithAttachments(api, subject);
	const context = await browser.newContext({ storageState: STORAGE_STATE, acceptDownloads: true });
	const page = await context.newPage();
	const document = await page.goto(`/inbox/${message.id}`);
	// Pages keep no opener reference to or from other windows.
	expect(document?.headers()["cross-origin-opener-policy"]).toBe("same-origin");

	const chip = page.locator('button[data-attachment-risk="danger"]', { hasText: "invoice.pdf.exe" });
	await expect(chip).toBeVisible();
	await expect(page.locator("button:not([data-attachment-risk])", { hasText: "notes.txt" })).toBeVisible();
	await chip.click();

	const dialog = page.getByRole("dialog", { name: "invoice.pdf.exe" });
	const warning = dialog.locator('[data-attachment-risk="danger"]');
	await expect(warning).toContainText("This file can harm your computer.");
	await expect(warning).toContainText("two extensions");
	await expect(dialog.getByRole("button", { name: "Download" })).toBeDisabled();
	await expect(dialog.getByRole("link", { name: "Download" })).toHaveCount(0);

	await dialog.getByRole("checkbox", { name: "I understand the risk" }).click();
	const link = dialog.getByRole("link", { name: "Download" });
	await expect(link).toHaveAttribute("href", /acknowledge=1/);
	const [download] = await Promise.all([page.waitForEvent("download"), link.click()]);
	expect(download.suggestedFilename()).toBe("invoice.pdf.exe");
	expect(await download.failure()).toBeNull();

	await context.close();
	await api.dispose();
});

test("Insert link with a hostile address adds one plain link and no markup", async ({ page }) => {
	const api = await apiContext(STORAGE_STATE);
	const subject = `Hostile link ${uniqueToken("link")}`;
	const address = 'https://example.com/"><img src=x id=injected>';
	try {
		await page.goto("/inbox");
		await page.getByRole("button", { name: "Compose" }).click();
		await expect(page.getByLabel("Subject")).toBeEditable();
		await page.getByLabel("Subject").fill(subject);
		const body = page.getByRole("textbox", { name: "Message body" });
		await body.fill("Read this: ");

		await page.getByRole("button", { name: "Insert link", exact: true }).click();
		await page.getByPlaceholder("https://example.com").fill(address);
		await page.getByRole("button", { name: "Apply", exact: true }).click();

		await expect(body.locator("a")).toHaveCount(1);
		await expect(body.locator("a")).toHaveAttribute("href", address);
		await expect(body.locator("a")).toHaveText(address);
		await expect(body.locator("img")).toHaveCount(0);
		await expect(page.locator("#injected")).toHaveCount(0);
	} finally {
		const { drafts } = (await (await api.get("/api/drafts")).json()) as { drafts: { id: string; subject: string }[] };
		for (const draft of drafts.filter((item) => item.subject === subject)) await api.delete(`/api/drafts/${draft.id}`);
		await api.dispose();
	}
});
