import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { STORAGE_STATE } from "./support/constants";
import { apiContext, uniqueToken, waitForMessage } from "./support/helpers";

const RECIPIENT = "reviewer@e2e.test";

let api: APIRequestContext;
let supportMailboxId: string;
let keyId: string;
let key: string;

/** Creates an assistant draft through the MCP draft tool, as Kite AI does from chat. */
async function createAgentDraft(subject: string): Promise<string> {
	const response = await api.post("/mcp", {
		headers: {
			Authorization: `Bearer ${key}`,
			Accept: "application/json, text/event-stream",
			"MCP-Protocol-Version": "2025-06-18",
			Origin: "",
		},
		data: {
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: "draft_email",
				arguments: { mailboxId: supportMailboxId, to: RECIPIENT, subject, body: "The screenshot is attached." },
			},
		},
	});
	expect(response.status(), await response.text()).toBe(200);
	const body = await response.text();
	const line = body.split("\n").find((item) => item.startsWith("data:")) ?? body;
	const payload = JSON.parse(line.replace(/^data:/, "")) as { result: { content: { text: string }[] } };
	return (JSON.parse(payload.result.content[0].text) as { draftId: string }).draftId;
}

async function openWithAttachment(page: Page, draftId: string, subject: string) {
	await page.goto(`/drafts/${draftId}`);
	await expect(page.getByLabel("Subject")).toHaveValue(subject);
	const composer = page.locator("form").filter({ has: page.getByRole("button", { name: "Close composer" }) });
	await composer.locator('input[type="file"]').setInputFiles({
		name: "screenshot.png",
		mimeType: "image/png",
		buffer: Buffer.from("not really a png"),
	});
	await expect(composer.getByText("screenshot.png")).toBeVisible();
}

/** Waits well past the composer's 900 ms autosave delay. */
async function idlePastAutosave(page: Page) {
	await page.waitForTimeout(2_500);
}

test.beforeAll(async () => {
	api = await apiContext(STORAGE_STATE);
	const mailboxes = (await (await api.get("/api/mailboxes")).json()) as {
		mailboxes: { id: string; localPart: string }[];
	};
	supportMailboxId = mailboxes.mailboxes.find((mailbox) => mailbox.localPart === "support")!.id;
	const created = await api.post("/api/agent/mcp-keys", {
		data: { name: "E2E draft review", mailboxIds: [supportMailboxId], scopes: ["mcp:read", "mcp:draft"] },
	});
	expect(created.ok(), await created.text()).toBe(true);
	({ id: keyId, key } = (await created.json()) as { id: string; key: string });
});

test.afterAll(async () => {
	await api.delete(`/api/agent/mcp-keys?id=${keyId}`);
	await api.dispose();
});

test("an assistant draft with a file added in the open composer sends after the review", async ({ page }) => {
	const subject = `Agent review ${uniqueToken()}`;
	const draftId = await createAgentDraft(subject);
	await openWithAttachment(page, draftId, subject);

	await page.getByRole("button", { name: "Review send" }).click();
	const dialog = page.getByRole("dialog", { name: "Review email before sending" });
	await expect(dialog.getByText("Attachments: screenshot.png")).toBeVisible();
	// The composer stays open behind the review; nothing it does on its own may invalidate the review.
	await idlePastAutosave(page);
	await dialog.getByRole("button", { name: "Confirm and send" }).click();
	await expect(dialog).toHaveCount(0);

	const message = await waitForMessage(api, subject, { status: "sent" });
	const detail = (await (await api.get(`/api/messages/${message.id}`)).json()) as {
		attachments: { filename: string }[];
	};
	expect(detail.attachments.map((attachment) => attachment.filename)).toEqual(["screenshot.png"]);
});

test("a real change after the review blocks the send until it is reviewed again", async ({ page }) => {
	const subject = `Agent change ${uniqueToken()}`;
	const draftId = await createAgentDraft(subject);
	await openWithAttachment(page, draftId, subject);

	await page.getByRole("button", { name: "Review send" }).click();
	const dialog = page.getByRole("dialog", { name: "Review email before sending" });
	await expect(dialog.getByText("Attachments: screenshot.png")).toBeVisible();

	// Another tab adds a file after the review was opened.
	const added = await api.post(`/api/drafts/${draftId}/attachments`, {
		multipart: { attachments: { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("Late notes") } },
	});
	expect(added.ok(), await added.text()).toBe(true);

	await dialog.getByRole("button", { name: "Confirm and send" }).click();
	await expect(dialog.getByRole("alert")).toHaveText("Draft changed; review it again");
	await dialog.getByRole("button", { name: "Review again" }).click();
	await expect(dialog.getByText(/Attachments: .*notes\.txt/)).toBeVisible();
	await dialog.getByRole("button", { name: "Confirm and send" }).click();
	await expect(dialog).toHaveCount(0);

	const message = await waitForMessage(api, subject, { status: "sent" });
	const detail = (await (await api.get(`/api/messages/${message.id}`)).json()) as {
		attachments: { filename: string }[];
	};
	expect(detail.attachments.map((attachment) => attachment.filename).sort()).toEqual(["notes.txt", "screenshot.png"]);
});
