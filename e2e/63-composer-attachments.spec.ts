import { deflateSync } from "node:zlib";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { STORAGE_STATE, SUPPORT_ADDRESS } from "./support/constants";
import { apiContext, deliverInbound, setSendingSettings, uniqueToken } from "./support/helpers";

// Attachments in the composer are chips that open: a click previews images (and PDFs, text) in the reader's
// viewer and downloads the rest, and the "…" menu offers Preview, Download and Remove.

const IMAGE_NAME = "CleanShot 2026-10-28 at 21.54.17.png";

/** A small opaque PNG (a diagonal gradient), so the thumbnail and the preview show something recognisable. */
function gradientPng(size = 64): Buffer {
	const crcTable = Array.from({ length: 256 }, (_, n) => {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		return c >>> 0;
	});
	const crc = (bytes: Buffer) => {
		let c = 0xffffffff;
		for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
		return (c ^ 0xffffffff) >>> 0;
	};
	const chunk = (type: string, data: Buffer) => {
		const body = Buffer.concat([Buffer.from(type), data]);
		const length = Buffer.alloc(4);
		length.writeUInt32BE(data.length);
		const check = Buffer.alloc(4);
		check.writeUInt32BE(crc(body));
		return Buffer.concat([length, body, check]);
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(size, 0);
	header.writeUInt32BE(size, 4);
	header.set([8, 2, 0, 0, 0], 8);
	const rows = Buffer.alloc(size * (size * 3 + 1));
	for (let y = 0; y < size; y++) {
		const row = y * (size * 3 + 1);
		for (let x = 0; x < size; x++) {
			rows.set([40 + x * 3, 90 + y * 2, 220 - x - y], row + 1 + x * 3);
		}
	}
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", header),
		chunk("IDAT", deflateSync(rows)),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

const PNG = gradientPng();

async function deliverOne(label: string, attachments = false): Promise<string> {
	const api = await apiContext(STORAGE_STATE);
	const subject = `${label} ${uniqueToken()}`;
	await deliverInbound(api, {
		from: `"Inline Sender" <inline@outside.test>`,
		to: SUPPORT_ADDRESS,
		subject,
		text: `Body of ${label}.`,
		attachments: attachments ? [{ filename: IMAGE_NAME, contentType: "image/png", content: PNG }] : undefined,
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

async function openReply(page: Page, subject: string) {
	await openMessage(page, subject);
	await page.getByRole("button", { name: /^Reply to Inline Sender/ }).click();
	const composer = inlineComposer(page);
	await expect(composer.getByRole("textbox", { name: "Message body" })).toBeFocused();
	return composer;
}

const chip = (composer: Locator, name = IMAGE_NAME) =>
	composer.getByRole("button", { name: new RegExp(`^(Preview|Download) ${name}`) });

async function expectImagePreview(page: Page) {
	const dialog = page.getByRole("dialog", { name: IMAGE_NAME });
	await expect(dialog).toBeVisible();
	const image = dialog.getByRole("img", { name: IMAGE_NAME });
	await expect(image).toBeVisible();
	await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(64);
	return dialog;
}

test.beforeEach(async ({ page }) => {
	const api = await apiContext(STORAGE_STATE);
	await setSendingSettings(api, { previewEnabled: false, undoSeconds: 0 });
	await api.dispose();
	await page.setViewportSize({ width: 1280, height: 900 });
});

test("a file attached in the inline reply opens in the viewer, downloads from its menu and is removed there", async ({
	page,
}, testInfo) => {
	const subject = await deliverOne("Attach stored");
	const composer = await openReply(page, subject);

	const stored = page.waitForResponse(
		(response) =>
			/^\/api\/drafts\/[^/]+\/attachments$/.test(new URL(response.url()).pathname) &&
			response.request().method() === "POST",
	);
	await composer.locator('input[type="file"]').setInputFiles({ name: IMAGE_NAME, mimeType: "image/png", buffer: PNG });
	expect((await stored).ok()).toBe(true);

	const open = chip(composer);
	await expect(open).toBeVisible();
	// A small file does not get the Cloudflare size warning, and the extension stays visible next to the name.
	await expect(composer.getByText(/Cloudflare limits general email messages/)).toHaveCount(0);
	await expect(composer.locator("[data-compose-attachment]").getByText(".png", { exact: true })).toBeVisible();
	await expect(composer.locator("[data-compose-attachment] img")).toBeVisible();

	await open.click();
	const dialog = await expectImagePreview(page);
	await page.screenshot({ path: testInfo.outputPath("preview.png") });
	await page.keyboard.press("Escape");
	await expect(dialog).toHaveCount(0);

	// The chip takes the keyboard: Enter opens the preview, and the dialog returns focus to it.
	await open.focus();
	await page.keyboard.press("Enter");
	await expectImagePreview(page);
	await page.keyboard.press("Escape");
	await expect(open).toBeFocused();

	const menuButton = composer.getByRole("button", { name: `More actions for ${IMAGE_NAME}` });
	await menuButton.click();
	const menu = page.getByRole("menu", { name: `Actions for ${IMAGE_NAME}` });
	await expect(menu.getByRole("menuitem")).toHaveText(["Preview", "Download", "Remove"]);
	await page.screenshot({ path: testInfo.outputPath("menu.png") });

	const download = page.waitForEvent("download");
	await menu.getByRole("menuitem", { name: "Download" }).click();
	const file = await download;
	expect(file.suggestedFilename()).toBe(IMAGE_NAME);
	const { readFile } = await import("node:fs/promises");
	expect((await readFile((await file.path())!)).equals(PNG)).toBe(true);

	await menuButton.click();
	await page
		.getByRole("menu", { name: `Actions for ${IMAGE_NAME}` })
		.getByRole("menuitem", { name: "Remove" })
		.click();
	await expect(open).toHaveCount(0);
});

test("a file that is not stored yet previews from the browser and the size notice appears only for big files", async ({
	page,
}) => {
	const subject = await deliverOne("Attach local");
	// The upload to the draft fails, so the file stays a local attachment of the composer.
	await page.route("**/api/drafts/*/attachments", (route) => route.abort());
	const composer = await openReply(page, subject);

	await composer.locator('input[type="file"]').setInputFiles({ name: IMAGE_NAME, mimeType: "image/png", buffer: PNG });
	await chip(composer).click();
	await expectImagePreview(page);
	await page.keyboard.press("Escape");

	await composer.getByRole("button", { name: `More actions for ${IMAGE_NAME}` }).click();
	const download = page.waitForEvent("download");
	await page.getByRole("menuitem", { name: "Download" }).click();
	expect((await download).suggestedFilename()).toBe(IMAGE_NAME);

	await expect(composer.getByText(/Cloudflare limits general email messages/)).toHaveCount(0);
	await composer.locator('input[type="file"]').setInputFiles({
		name: "bundle.zip",
		mimeType: "application/zip",
		buffer: Buffer.alloc(3_200_000, 1),
	});
	await expect(composer.getByText(/files over 3 MB are sent as 30-day R2 download links/)).toBeVisible();
	// A type the viewer cannot show downloads on click instead of opening a dialog.
	const zipDownload = page.waitForEvent("download");
	await chip(composer, "bundle.zip").click();
	expect((await zipDownload).suggestedFilename()).toBe("bundle.zip");
	await expect(page.getByRole("dialog")).toHaveCount(0);

	await composer.getByRole("button", { name: "More actions for bundle.zip" }).click();
	await page.getByRole("menuitem", { name: "Remove" }).click();
	await expect(composer.getByText(/Cloudflare limits general email messages/)).toHaveCount(0);
	await expect(chip(composer)).toBeVisible();
});

test("an attachment carried over by Forward opens from the forward composer", async ({ page }) => {
	const subject = await deliverOne("Attach forward", true);
	await openMessage(page, subject);
	await page.keyboard.press("f");
	const composer = inlineComposer(page);
	await expect(composer.getByLabel("Subject")).toHaveValue(`Fwd: ${subject}`);

	await expect(chip(composer)).toBeVisible();
	await chip(composer).click();
	await expectImagePreview(page);
	await page.keyboard.press("Escape");

	await composer.getByRole("button", { name: `More actions for ${IMAGE_NAME}` }).click();
	const download = page.waitForEvent("download");
	await page.getByRole("menuitem", { name: "Download" }).click();
	expect((await download).suggestedFilename()).toBe(IMAGE_NAME);
});

test("the full composer shows the same chips for a forwarded file", async ({ page }) => {
	const subject = await deliverOne("Attach popout", true);
	await openMessage(page, subject);
	await page.keyboard.press("f");
	const inline = inlineComposer(page);
	await expect(chip(inline)).toBeVisible();
	await inline.getByRole("button", { name: "Pop out composer" }).click();
	const window = page.getByRole("region", { name: "Compose message" });
	await expect(window.getByRole("button", { name: "Minimize composer" })).toBeVisible();
	await chip(window).click();
	await expectImagePreview(page);
});

const textFile = (name: string, text = `${name} contents`) => ({
	name,
	mimeType: "text/plain",
	buffer: Buffer.from(text),
});

/** A composer whose uploads to the draft fail, so every file stays a local attachment. */
async function localOnlyComposer(page: Page, label: string) {
	const subject = await deliverOne(label);
	await page.route("**/api/drafts/*/attachments", (route) => route.abort());
	return openReply(page, subject);
}

test("removing a chip from its menu moves the focus to the next chip, else the previous one, else Attach", async ({
	page,
}) => {
	const composer = await localOnlyComposer(page, "Attach focus");
	await composer.locator('input[type="file"]').setInputFiles([textFile("a.txt"), textFile("b.txt"), textFile("c.txt")]);
	await expect(composer.locator("[data-compose-attachment]")).toHaveCount(3);

	async function removeViaMenu(name: string) {
		await composer.getByRole("button", { name: `More actions for ${name}` }).click();
		await page.getByRole("menuitem", { name: "Remove" }).click();
		await expect(composer.locator(`[data-compose-attachment="${name}"]`)).toHaveCount(0);
	}

	await removeViaMenu("b.txt");
	await expect(chip(composer, "c.txt")).toBeFocused();
	await removeViaMenu("c.txt");
	await expect(chip(composer, "a.txt")).toBeFocused();
	await removeViaMenu("a.txt");
	await expect(composer.getByRole("button", { name: "Attach files" })).toBeFocused();
});

test("menu → Preview opens the viewer, Escape returns the focus to the menu button and the page stays clickable", async ({
	page,
}) => {
	const composer = await localOnlyComposer(page, "Attach menu focus");
	await composer.locator('input[type="file"]').setInputFiles(textFile("notes.txt"));
	const menuButton = composer.getByRole("button", { name: "More actions for notes.txt" });
	await menuButton.click();
	await page.getByRole("menuitem", { name: "Preview" }).click();
	const dialog = page.getByRole("dialog", { name: "notes.txt" });
	await expect(dialog).toBeVisible();
	await expect(dialog.getByText("notes.txt contents")).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(dialog).toHaveCount(0);

	await expect(menuButton).toBeFocused();
	// A menu that opened the dialog while still closing would leave the page's pointer-events locked.
	await expect.poll(() => page.evaluate(() => document.body.style.pointerEvents)).not.toBe("none");
	const body = composer.getByRole("textbox", { name: "Message body" });
	await body.click();
	await expect(body).toBeFocused();
});

test("an unsaved text file with markup previews as literal text and runs nothing", async ({ page }) => {
	const composer = await localOnlyComposer(page, "Attach script");
	const markup =
		'<script>window.__attachmentScriptRan = true</script><img src=x onerror="window.__attachmentScriptRan = true">';
	await composer.locator('input[type="file"]').setInputFiles(textFile("markup.txt", markup));
	await chip(composer, "markup.txt").click();
	const dialog = page.getByRole("dialog", { name: "markup.txt" });
	await expect(dialog.locator("pre")).toHaveText(markup);
	await expect(dialog.locator("script, img[onerror]")).toHaveCount(0);
	expect(
		await page.evaluate(() => (window as unknown as { __attachmentScriptRan?: boolean }).__attachmentScriptRan),
	).toBeUndefined();
});

test("the Cloudflare link notice and the Attach tooltip follow the From domain's sending provider", async ({
	page,
}) => {
	const composer = await localOnlyComposer(page, "Attach provider");
	for (const cloudLinks of [true, false]) {
		await page.route("**/api/attachment-policy*", (route) =>
			route.fulfill({ json: { maxMb: 25, cloudThresholdBytes: 3_000_000, cloudLinks } }),
		);
		await page.reload();
		await page.getByRole("button", { name: /^Reply to Inline Sender/ }).click();
		const reply = inlineComposer(page);
		await reply.locator('input[type="file"]').setInputFiles({
			name: "big.zip",
			mimeType: "application/zip",
			buffer: Buffer.alloc(3_200_000, 1),
		});
		await expect(chip(reply, "big.zip")).toBeVisible();
		const notice = reply.getByText(/Cloudflare limits general email messages/);
		if (cloudLinks) await expect(notice).toBeVisible();
		else await expect(notice).toHaveCount(0);
		await reply.getByRole("button", { name: "Attach files" }).hover();
		const tooltip = page.getByRole("tooltip");
		await expect(tooltip).toContainText("Attach files (up to 25 MB total)");
		if (cloudLinks) await expect(tooltip).toContainText("R2 download links");
		else await expect(tooltip).not.toContainText("R2 download links");
	}
	void composer;
});

test("the attachment policy tells the composer whether the From domain sends through Cloudflare", async () => {
	const api = await apiContext(STORAGE_STATE);
	const hostname = `policy-${uniqueToken("")}.example.test`.toLowerCase();
	const created = await api.post("/api/domains", { data: { hostname, skipDns: true } });
	expect(created.ok(), await created.text()).toBe(true);
	const listed = (await (await api.get("/api/domains")).json()) as { domains: { id: string; hostname: string }[] };
	const domain = listed.domains.find((item) => item.hostname === hostname)!;
	const policy = async (from: string) =>
		(await (await api.get(`/api/attachment-policy?from=${encodeURIComponent(from)}`)).json()) as {
			cloudLinks: boolean;
			cloudThresholdBytes: number;
		};
	try {
		// A domain without a sending provider, an unknown one and no address at all keep the Cloudflare wording.
		expect((await policy(`me@${hostname}`)).cloudLinks).toBe(true);
		expect((await policy("me@unknown.example.test")).cloudLinks).toBe(true);
		expect(((await (await api.get("/api/attachment-policy")).json()) as { cloudLinks: boolean }).cloudLinks).toBe(true);
		for (const provider of ["resend", "ses"]) {
			const set = await api.put(`/api/domains/${domain.id}/sending`, { data: { provider } });
			expect(set.ok(), await set.text()).toBe(true);
			expect(await policy(`Me <me@${hostname}>`)).toMatchObject({ cloudLinks: false, cloudThresholdBytes: 3_000_000 });
		}
		await api.put(`/api/domains/${domain.id}/sending`, { data: { provider: "none" } });
		expect((await policy(`me@${hostname}`)).cloudLinks).toBe(true);
	} finally {
		await api.delete(`/api/domains/${domain.id}`);
		await api.dispose();
	}
});
