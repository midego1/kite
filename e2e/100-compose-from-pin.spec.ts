import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import { createSharedMailbox, createSignedInAccount, okJson, selectMailbox, shareMailbox } from "./support/auto-read";
import { DOMAIN, STORAGE_STATE } from "./support/constants";
import { apiContext, deliverInbound, openMessage, setSendingSettings, uniqueToken } from "./support/helpers";
import { chooseOption, expectSelectValue } from "./support/select";

// A reopened draft goes back to its own mailbox once, when it loads. After that the From the user picks stays, the
// message goes out from it, and the signature of the mailbox it was written in is not added a second time.

const RECIPIENT = "receiver@e2e.test";
const ARABIC = "مرحبا بالعالم";
const OWN_SIGNATURE = "Own signature text";
const SHARED_SIGNATURE = "Shared signature text";

function editor(page: Page) {
	return page.getByRole("textbox", { name: "Message body" });
}

function fromSelect(page: Page) {
	return page.getByRole("combobox", { name: "From" });
}

function countOf(text: string, part: string) {
	return text.split(part).length - 1;
}

async function setUp(api: APIRequestContext, ownSignature: string) {
	const username = `frompin${uniqueToken("")}`;
	const account = await createSignedInAccount(api, username);
	await setSendingSettings(account.api, { previewEnabled: false, undoSeconds: 0 });
	const sharedName = `frompinshared${uniqueToken("")}`;
	const sharedId = await createSharedMailbox(api, sharedName);
	await shareMailbox(api, sharedId, account.id, "full_access");
	await okJson(await api.patch(`/api/mailboxes/${sharedId}`, { data: { signature: SHARED_SIGNATURE } }));
	await okJson(await account.api.patch(`/api/mailboxes/${account.mailboxId}`, { data: { signature: ownSignature } }));
	return {
		account,
		username,
		sharedId,
		sharedName,
		own: `${account.mailboxId}|${username}@${DOMAIN}`,
		shared: `${sharedId}|${sharedName}@${DOMAIN}`,
	};
}

async function openAs(browser: Browser, account: { api: APIRequestContext }, mailboxId: string) {
	const context = await browser.newContext({ storageState: await account.api.storageState() });
	const page = await context.newPage();
	await selectMailbox(page, mailboxId);
	return { context, page };
}

/** The saved draft whose body holds `marker`, once its signature has been saved too. */
async function savedDraftId(account: { api: APIRequestContext }, marker: string, includes: string) {
	let draftId = "";
	await expect
		.poll(async () => {
			const { drafts } = (await (await account.api.get("/api/drafts")).json()) as {
				drafts: { id: string; htmlBody: string | null }[];
			};
			const draft = drafts.find((item) => item.htmlBody?.includes(marker));
			draftId = draft?.id ?? "";
			return draft?.htmlBody?.includes(includes) ?? false;
		})
		.toBe(true);
	return draftId;
}

test.describe("composer From and signature of a reopened draft", () => {
	let api: APIRequestContext;

	test.beforeEach(async () => {
		api = await apiContext(STORAGE_STATE);
	});

	test.afterEach(async () => {
		await api.dispose();
	});

	test("changing From in a reopened draft stays, and the message goes out from the chosen mailbox", async ({
		browser,
	}) => {
		const setup = await setUp(api, OWN_SIGNATURE);
		const { account, sharedId } = setup;
		const created = await account.api.post("/api/drafts", {
			data: {
				mailboxId: account.mailboxId,
				from: `${setup.username}@${DOMAIN}`,
				to: RECIPIENT,
				subject: `From pin ${uniqueToken("")}`,
				html: "<div>Body text</div>",
			},
		});
		const { draft } = await okJson<{ draft: { id: string } }>(created);
		const { context, page } = await openAs(browser, account, account.mailboxId);
		try {
			await page.goto(`/drafts/${draft.id}`);
			await expect(editor(page)).toContainText("Body text");
			await expectSelectValue(fromSelect(page), setup.own);

			await chooseOption(fromSelect(page), setup.shared);
			// The shared mailbox's signature replaces the own one, and the From stays on the shared address.
			await expect(editor(page)).toContainText(SHARED_SIGNATURE);
			await expect(editor(page)).not.toContainText(OWN_SIGNATURE);
			await expectSelectValue(fromSelect(page), setup.shared);

			const sendRequest = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/send");
			await page.getByRole("button", { name: "Send", exact: true }).click();
			const body = (await sendRequest).postData() ?? "";
			expect(body).toContain(sharedId);
			expect(body).toContain(`${setup.sharedName}@${DOMAIN}`);
			expect(body).not.toContain(account.mailboxId);
			await expect.poll(async () => (await page.request.get(`/api/drafts/${draft.id}`)).status()).toBe(404);
		} finally {
			await context.close();
			await account.api.dispose();
		}
	});

	test("reopening a draft while another mailbox with a signature is selected keeps one signature", async ({
		browser,
	}) => {
		const setup = await setUp(api, OWN_SIGNATURE);
		const { account, sharedId } = setup;
		const writer = await openAs(browser, account, account.mailboxId);
		let draftId = "";
		try {
			await writer.page.goto("/inbox");
			await writer.page.getByRole("button", { name: "Compose" }).click();
			await expect(editor(writer.page)).toContainText(OWN_SIGNATURE);
			await editor(writer.page).locator("> div").first().click();
			await writer.page.keyboard.type("Body text");
			draftId = await savedDraftId(account, "Body text", OWN_SIGNATURE);
		} finally {
			await writer.context.close();
		}
		const reader = await openAs(browser, account, sharedId);
		try {
			await reader.page.goto(`/drafts/${draftId}`);
			await expect(editor(reader.page)).toContainText("Body text");
			await expectSelectValue(fromSelect(reader.page), setup.own);
			await expect(editor(reader.page).locator("[data-kite-signature]")).toHaveCount(1);
			await expect.poll(async () => countOf(await editor(reader.page).innerText(), OWN_SIGNATURE)).toBe(1);
			await expect(editor(reader.page)).not.toContainText(SHARED_SIGNATURE);
		} finally {
			await reader.context.close();
			await account.api.dispose();
		}
	});

	test("changing the mailbox in the sidebar does not move a reply that was popped out", async ({ browser }) => {
		const setup = await setUp(api, OWN_SIGNATURE);
		const { account, sharedId } = setup;
		const subject = `Pinned reply ${uniqueToken("")}`;
		await deliverInbound(account.api, {
			from: `"Pin Sender" <pin@outside.test>`,
			to: `${setup.username}@${DOMAIN}`,
			subject,
			text: "Please answer.",
		});
		const { context, page } = await openAs(browser, account, account.mailboxId);
		try {
			await page.goto("/inbox");
			await openMessage(page, subject);
			await expect(page.getByRole("heading", { level: 1, name: subject })).toBeVisible();
			await page.getByRole("button", { name: /^Reply to Pin Sender/ }).click();
			await page.getByRole("button", { name: "Pop out composer" }).click();
			const popup = page.getByRole("region", { name: "Compose message" });
			await expect(popup.getByRole("button", { name: "Minimize composer" })).toBeVisible();
			await expect(popup.getByRole("textbox", { name: "Message body" })).toContainText(OWN_SIGNATURE);
			await expectSelectValue(popup.getByRole("combobox", { name: "From" }), setup.own);
			await popup.getByRole("textbox", { name: "Message body" }).pressSequentially("Reply text");

			// The sidebar moves to the shared mailbox; the open reply stays in its own.
			await page.getByRole("button", { name: "Open account menu" }).click();
			await page.getByRole("button", { name: /^Inboxes \(\d+\)/ }).click();
			await page.getByRole("button", { name: new RegExp(`^${setup.sharedName} Shared inbox`) }).click();
			await expect(page).toHaveURL(/\/inbox$/);
			await expect(page.getByRole("button", { name: "Open account menu" })).toContainText(setup.sharedName);
			await expect(popup.getByRole("button", { name: "Minimize composer" })).toBeVisible();
			await expectSelectValue(popup.getByRole("combobox", { name: "From" }), setup.own);
			await expect(popup.getByRole("textbox", { name: "Message body" })).toContainText(OWN_SIGNATURE);
			await expect(popup.getByRole("textbox", { name: "Message body" })).not.toContainText(SHARED_SIGNATURE);

			const sendRequest = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/send");
			await popup.getByRole("button", { name: "Send", exact: true }).click();
			const body = (await sendRequest).postData() ?? "";
			expect(body).toContain(account.mailboxId);
			expect(body).not.toContain(sharedId);
			expect(body).toContain("inReplyTo");
			expect(body).toContain(`${setup.username}@${DOMAIN}`);
		} finally {
			await context.close();
			await account.api.dispose();
		}
	});

	test("an assistant draft cannot be moved to another mailbox from the From menu", async ({ browser }) => {
		const setup = await setUp(api, OWN_SIGNATURE);
		const { account } = setup;
		const created = await account.api.post("/api/agent/mcp-keys", {
			data: { name: "From pin", mailboxIds: [account.mailboxId], scopes: ["mcp:read", "mcp:draft"] },
		});
		const { key } = await okJson<{ key: string }>(created);
		const drafted = await account.api.post("/mcp", {
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
					arguments: {
						mailboxId: account.mailboxId,
						to: RECIPIENT,
						subject: `Assistant ${uniqueToken("")}`,
						body: "Hi.",
					},
				},
			},
		});
		expect(drafted.status(), await drafted.text()).toBe(200);
		const text = await drafted.text();
		const line = text.split("\n").find((item) => item.startsWith("data:")) ?? text;
		const payload = JSON.parse(line.replace(/^data:/, "")) as { result: { content: { text: string }[] } };
		const { draftId } = JSON.parse(payload.result.content[0]!.text) as { draftId: string };
		const { context, page } = await openAs(browser, account, account.mailboxId);
		try {
			await page.goto(`/drafts/${draftId}`);
			await expect(page.getByLabel("Subject")).toHaveValue(/^Assistant /);
			await expectSelectValue(fromSelect(page), setup.own);
			await fromSelect(page).click();
			const listbox = page.getByRole("listbox");
			await expect(listbox).toBeVisible();
			await expect(listbox.locator(`[role="option"][data-value="${setup.shared}"]`)).toHaveAttribute(
				"aria-disabled",
				"true",
			);
			await expect(listbox.locator(`[role="option"][data-value="${setup.own}"]`)).not.toHaveAttribute(
				"aria-disabled",
				"true",
			);
			await page.keyboard.press("Escape");
			await expectSelectValue(fromSelect(page), setup.own);
		} finally {
			await context.close();
			await account.api.dispose();
		}
	});

	for (const press of ["a line", "Ctrl+A"] as const) {
		test(`the direction button on ${press} in a block-level signature does not add a second signature`, async ({
			browser,
		}) => {
			const setup = await setUp(api, `<div>${ARABIC}</div><div>Sam</div>`);
			const { account } = setup;
			const { context, page } = await openAs(browser, account, account.mailboxId);
			try {
				await page.goto("/inbox");
				await page.getByRole("button", { name: "Compose" }).click();
				const signature = editor(page).locator("[data-kite-signature]");
				await expect(signature).toContainText(ARABIC);
				await editor(page).locator("> div").first().click();
				await page.keyboard.type("Body text");

				if (press === "a line") await signature.locator("div").filter({ hasText: "Sam" }).click();
				else await page.keyboard.press("Control+A");
				await page.getByRole("button", { name: /^Paragraph direction/ }).click();

				await chooseOption(fromSelect(page), setup.shared);
				await expect(editor(page)).toContainText(SHARED_SIGNATURE);
				await expect(editor(page)).not.toContainText(ARABIC);
				await expect(editor(page).locator("[data-kite-signature]")).toHaveCount(1);

				// Back again, then reopen the saved draft: the signature is found, not added again.
				await chooseOption(fromSelect(page), setup.own);
				await expect(editor(page)).toContainText(ARABIC);
				await expect(editor(page).locator("[data-kite-signature]")).toHaveCount(1);
				const draftId = await savedDraftId(account, "Body text", ARABIC);
				await page.goto(`/drafts/${draftId}`);
				await expect(editor(page)).toContainText("Body text");
				await expect(editor(page).locator("[data-kite-signature]")).toHaveCount(1);
				await expect.poll(async () => countOf(await editor(page).innerText(), "Sam")).toBe(1);
			} finally {
				await context.close();
				await account.api.dispose();
			}
		});
	}
});
