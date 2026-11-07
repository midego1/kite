import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { STORAGE_STATE, SUPPORT_ADDRESS } from "./support/constants";
import { apiContext, deliverInbound, setSendingSettings, uniqueToken, waitForMessage } from "./support/helpers";

// Files dropped on or pasted into the composer become attachments, in the floating composer, the docked reply and the
// full-screen one; pasted text keeps going in as plain text.

const RECIPIENT = "receiver@e2e.test";
// One transparent pixel.
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

type TestFile = { name: string; type: string; base64: string };

const AGENDA: TestFile = { name: "agenda.txt", type: "text/plain", base64: Buffer.from("Agenda\n").toString("base64") };
const PIXEL: TestFile = { name: "pixel.png", type: "image/png", base64: PNG_BASE64 };

/**
 * A drag from the desktop, through the browser's own drag machinery (the DevTools protocol), so the browser's default
 * actions run as they would for a person: a file dropped on an editable area is inserted or opened unless the page
 * cancels the drop.
 */
async function desktopDrag(page: Page, target: Locator, phase: "dragEnter" | "dragOver" | "drop", paths: string[]) {
	const box = await target.boundingBox();
	if (!box) throw new Error("the drop target has no box");
	const cdp = await page.context().newCDPSession(page);
	await cdp.send("Input.dispatchDragEvent", {
		type: phase,
		x: box.x + box.width / 2,
		y: box.y + box.height / 2,
		data: { items: [], files: paths, dragOperationsMask: 1 },
	});
	await cdp.detach();
}

async function dropFile(page: Page, target: Locator, paths: string[]) {
	await desktopDrag(page, target, "dragEnter", paths);
	await desktopDrag(page, target, "dragOver", paths);
	await desktopDrag(page, target, "drop", paths);
}

/** Whether the page cancels a file drag over `target` (which then opens nowhere); a drop zone or input leaves it alone. */
function dragoverCancelled(target: Locator, file: TestFile) {
	return target.evaluate((element, args) => {
		const transfer = new DataTransfer();
		const bytes = Uint8Array.from(atob(args.base64), (char) => char.charCodeAt(0));
		transfer.items.add(new File([bytes], args.name, { type: args.type }));
		const event = new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: transfer });
		element.dispatchEvent(event);
		return event.defaultPrevented;
	}, file);
}

function fileOnDisk(directory: string, file: TestFile): string {
	const path = join(directory, file.name);
	writeFileSync(path, Buffer.from(file.base64, "base64"));
	return path;
}

/** Pastes `files` (and `text`, when given) into `target` the way a browser delivers a clipboard. */
async function pasteInto(
	target: Locator,
	{ files = [], text, html }: { files?: TestFile[]; text?: string; html?: string },
) {
	return target.evaluate(
		(element, args) => {
			const transfer = new DataTransfer();
			for (const file of args.files) {
				const bytes = Uint8Array.from(atob(file.base64), (char) => char.charCodeAt(0));
				transfer.items.add(new File([bytes], file.name, { type: file.type }));
			}
			if (args.text !== undefined) transfer.setData("text/plain", args.text);
			if (args.html !== undefined) transfer.setData("text/html", args.html);
			const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer });
			element.dispatchEvent(event);
			return event.defaultPrevented;
		},
		{ files, text, html },
	);
}

function floating(page: Page) {
	return page.getByRole("region", { name: "Compose message" }).last();
}

async function openFloating(page: Page, path = "/inbox") {
	await page.goto(path);
	await page.getByRole("button", { name: "Compose" }).click();
	const composer = floating(page);
	const to = composer.getByLabel("To", { exact: true });
	await to.fill(RECIPIENT);
	await to.press("Enter");
	await expect(composer.getByRole("button", { name: `Remove ${RECIPIENT}` })).toBeVisible();
	return composer;
}

function body(composer: Locator) {
	return composer.getByRole("textbox", { name: "Message body" });
}

async function openDockedReply(page: Page) {
	const api = await apiContext(STORAGE_STATE);
	const subject = `Drop reply ${uniqueToken()}`;
	await deliverInbound(api, {
		from: `"Drop Sender" <drop@outside.test>`,
		to: SUPPORT_ADDRESS,
		subject,
		text: "Please send the agenda.",
	});
	await api.dispose();
	await page.goto("/inbox");
	await page
		.getByRole("list", { name: "Inbox" })
		.locator("[data-message-row]")
		.filter({ has: page.getByText(subject, { exact: true }) })
		.getByRole("link")
		.click();
	await expect(page.getByRole("heading", { level: 1, name: subject })).toBeVisible();
	await page.getByRole("button", { name: /^Reply to Drop Sender/ }).click();
	const composer = page
		.getByRole("main")
		.getByRole("region", { name: "Compose message" })
		.filter({ has: page.getByRole("button", { name: "Pop out composer" }) });
	await expect(body(composer)).toBeFocused();
	return { composer, subject };
}

test.describe("files dropped on and pasted into the composer", () => {
	let files: string;

	test.beforeAll(() => {
		files = mkdtempSync(join(tmpdir(), "kite-composer-files-"));
	});

	test.afterEach(async () => {
		const api = await apiContext(STORAGE_STATE);
		await setSendingSettings(api, { previewEnabled: false, undoSeconds: 0 });
		await api.dispose();
	});

	test("a file dropped on the message body of the floating composer is attached, with a drop target while dragging", async ({
		page,
	}) => {
		const composer = await openFloating(page);
		const editor = body(composer);
		const agenda = [fileOnDisk(files, AGENDA)];
		const address = page.url();
		await desktopDrag(page, editor, "dragEnter", agenda);
		await desktopDrag(page, editor, "dragOver", agenda);
		await expect(composer.getByText("Drop files to attach")).toBeVisible();
		// The drag leaves; a browser may hide its types by then.
		await editor.evaluate((element) => element.dispatchEvent(new DragEvent("dragleave", { bubbles: true })));
		await expect(composer.getByText("Drop files to attach")).toBeHidden();

		await dropFile(page, editor, agenda);
		await expect(composer.getByText("Drop files to attach")).toBeHidden();
		await expect(composer.getByText("agenda.txt")).toBeVisible();
		// Not inserted into the text, and the browser did not open the file.
		await expect(editor).toHaveText("");
		expect(page.url()).toBe(address);
	});

	test("a drop on the docked reply and on the full-screen composer attaches too", async ({ page }) => {
		const { composer } = await openDockedReply(page);
		await dropFile(page, body(composer), [fileOnDisk(files, PIXEL)]);
		await expect(composer.getByText("pixel.png")).toBeVisible();

		await page.goto("/inbox");
		const popup = await openFloating(page);
		await popup.getByRole("button", { name: "Open composer as modal" }).click();
		const modal = page.getByRole("dialog", { name: "Compose message" });
		await dropFile(page, body(modal), [fileOnDisk(files, AGENDA)]);
		await expect(modal.getByText("agenda.txt")).toBeVisible();
	});

	test("a file dropped beside the composer does not open in the tab", async ({ page }) => {
		const composer = await openFloating(page);
		await body(composer).fill("Draft that must survive");
		const address = page.url();
		await dropFile(page, page.getByRole("main"), [fileOnDisk(files, AGENDA)]);
		await expect(body(composer)).toHaveText("Draft that must survive");
		expect(page.url()).toBe(address);
	});

	test("a file dropped on a file input is left to the browser while a composer is open, and a minimized composer lets go", async ({
		page,
	}) => {
		const composer = await openFloating(page, "/settings/import");
		const input = page.locator("#import-files");
		await expect(input).toBeVisible();
		// The drop on an input is what puts the file in it, so the page must not cancel it; beside the input it does.
		expect(await dragoverCancelled(input, AGENDA)).toBe(false);
		expect(await dragoverCancelled(page.getByRole("main"), AGENDA)).toBe(true);
		await composer.getByRole("button", { name: "Minimize composer" }).click();
		expect(await dragoverCancelled(page.getByRole("main"), AGENDA)).toBe(false);
	});

	test("a pasted file never takes the name of one already attached", async ({ page }) => {
		const composer = await openFloating(page);
		const editor = body(composer);
		await editor.click();
		await pasteInto(editor, { files: [AGENDA] });
		await expect(composer.getByText("agenda.txt")).toBeVisible();
		await pasteInto(editor, { files: [AGENDA] });
		await expect(composer.getByText("agenda-2.txt")).toBeVisible();
	});

	test("a drag that carries no files leaves the composer alone", async ({ page }) => {
		const composer = await openFloating(page);
		await body(composer).evaluate((element) => {
			const transfer = new DataTransfer();
			transfer.setData("text/plain", "just text");
			element.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: transfer }));
		});
		await expect(composer.getByText("Drop files to attach")).toBeHidden();
	});

	test("a pasted screenshot is attached with a dated name and is sent with the draft", async ({ page }) => {
		const composer = await openFloating(page);
		const subject = `Paste image ${uniqueToken()}`;
		await composer.getByLabel("Subject").fill(subject);
		const editor = body(composer);
		await editor.fill("Screenshot below.");
		await editor.click();
		const prevented = await pasteInto(editor, { files: [{ ...PIXEL, name: "image.png" }] });
		expect(prevented).toBe(true);
		await expect(composer.getByText(/^screenshot-\d{4}-\d{2}-\d{2}-\d{4}\.png$/)).toBeVisible();
		await expect(editor).toHaveText("Screenshot below.");

		const sent = page.waitForResponse(
			(response) => response.url().endsWith("/api/send") && response.request().method() === "POST",
		);
		await composer.getByRole("button", { name: "Send", exact: true }).click();
		expect((await sent).ok()).toBe(true);
		const api = await apiContext(STORAGE_STATE);
		const message = await waitForMessage(api, subject, { status: "sent" });
		const detail = (await (await api.get(`/api/messages/${message.id}`)).json()) as {
			attachments: { filename: string }[];
		};
		expect(detail.attachments).toHaveLength(1);
		expect(detail.attachments[0].filename).toMatch(/^screenshot-\d{4}-\d{2}-\d{2}-\d{4}\.png$/);
		await api.dispose();
	});

	test("a pasted file keeps its own name, and pasted text still goes in as plain text", async ({ page }) => {
		const composer = await openFloating(page);
		const editor = body(composer);
		await editor.click();
		await pasteInto(editor, { files: [AGENDA] });
		await expect(composer.getByText("agenda.txt")).toBeVisible();

		await pasteInto(editor, { text: "Plain words" });
		await expect(editor).toHaveText("Plain words");
		// Text and a picture together (a copy from a web page): the text goes in, the picture is not added again.
		await pasteInto(editor, { text: " and more", html: "<b> and more</b>", files: [PIXEL] });
		await expect(editor).toHaveText("Plain words and more");
		await expect(composer.getByText("pixel.png")).toBeHidden();
	});

	test("a pasted file over the limits is refused like a picked one", async ({ page }) => {
		const composer = await openFloating(page);
		for (let index = 0; index < 11; index += 1) {
			await pasteInto(body(composer), { files: [{ ...AGENDA, name: `file-${index}.txt` }] });
		}
		await expect(page.getByText("A message can include at most 10 attachments")).toBeVisible();
	});
});
