import { expect, test, type APIRequestContext } from "@playwright/test";
import { STORAGE_STATE } from "./support/constants";
import { apiContext, uniqueToken } from "./support/helpers";
import { createMcpKey, mcpCall } from "./support/mcp";

let api: APIRequestContext;
let supportMailboxId: string;
let keyId: string;
let key: string;

/** Calls an MCP tool and returns its parsed result, as an MCP client acting on injected mail would. */
async function callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
	const response = await mcpCall(api, key, "tools/call", { name, arguments: { mailboxId: supportMailboxId, ...args } });
	const result = response.result as { content: { text: string }[]; isError?: boolean };
	expect(result.isError, result.content[0]?.text).toBeFalsy();
	return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

async function createAgentDraft(to: string, subject: string): Promise<string> {
	const draft = await callTool("draft_email", { to, subject, body: "Here are the figures you asked for." });
	return draft.draftId as string;
}

test.beforeAll(async () => {
	api = await apiContext(STORAGE_STATE);
	const mailboxes = (await (await api.get("/api/mailboxes")).json()) as {
		mailboxes: { id: string; localPart: string }[];
	};
	supportMailboxId = mailboxes.mailboxes.find((mailbox) => mailbox.localPart === "support")!.id;
	({ id: keyId, key } = await createMcpKey(
		api,
		"E2E send review warnings",
		["mcp:read", "mcp:draft", "mcp:request-send"],
		[supportMailboxId],
	));
});

test.afterAll(async () => {
	await api.delete(`/api/agent/mcp-keys?id=${keyId}`);
	await api.dispose();
});

test("the send review says the AI wrote the draft and warns about a recipient the user never wrote to", async ({
	page,
}) => {
	const stranger = `${uniqueToken("stranger")}@e2e.test`;
	const subject = `Review warning ${uniqueToken()}`;
	const draftId = await createAgentDraft(stranger, subject);
	await page.goto(`/drafts/${draftId}`);
	await expect(page.getByLabel("Subject")).toHaveValue(subject);
	await page.getByRole("button", { name: "Review send" }).click();

	const dialog = page.getByRole("dialog", { name: "Review email before sending" });
	await expect(dialog.locator("[data-send-review-ai-origin]")).toContainText(
		"The AI assistant wrote this message, partly from email content that anyone could have written.",
	);
	const warning = dialog.locator("[data-send-review-unfamiliar]");
	await expect(warning).toContainText("You have never written to this address and it is not in your contacts");
	await expect(warning).toContainText(stranger);
	await dialog.getByRole("button", { name: "Cancel" }).click();
	await expect(dialog).toHaveCount(0);
});

test("a saved contact is familiar: the review keeps the AI notice but drops the recipient warning", async ({
	page,
}) => {
	const known = `${uniqueToken("known")}@e2e.test`;
	const saved = await api.patch("/api/contacts", {
		data: { mailboxId: supportMailboxId, address: known, displayName: "Known Person" },
	});
	expect(saved.ok(), await saved.text()).toBe(true);
	const subject = `Review familiar ${uniqueToken()}`;
	const draftId = await createAgentDraft(known, subject);

	// The review link an MCP client hands the user opens the same review on its own page.
	const draft = (await callTool("get_email", { emailId: draftId })) as { revision: number };
	const request = await callTool("request_send", { draftId, expectedRevision: draft.revision });
	await page.goto(new URL(request.reviewUrl as string).pathname);

	const dialog = page.getByRole("dialog", { name: "Review email before sending" });
	await expect(dialog.getByText(subject)).toBeVisible();
	await expect(dialog.locator("[data-send-review-ai-origin]")).toBeVisible();
	await expect(dialog.locator("[data-send-review-unfamiliar]")).toHaveCount(0);
});
