import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { STORAGE_STATE, SUPPORT_ADDRESS } from "./support/constants";
import { apiContext, deliverInbound, uniqueToken } from "./support/helpers";
import { useFakeProvider } from "./support/agent";
import { selectMailbox } from "./support/auto-read";
import { askAssistant, chatRequests, firstMailboxId, openAssistantPanel } from "./support/chat";
import { startFakeModel } from "./support/fake-model";
import type { FakeModel } from "./support/fake-model-types";

let api: APIRequestContext;
let fake: FakeModel;
let restore: (() => Promise<void>) | undefined;

test.beforeAll(async () => {
	api = await apiContext(STORAGE_STATE);
	fake = await startFakeModel();
	restore = await useFakeProvider(api, fake);
});

test.afterAll(async () => {
	await restore?.();
	await fake?.close();
	await api.dispose();
});

type StoredState = { folderId: string | null; read: boolean; status: string };

async function messageState(id: string): Promise<StoredState> {
	const response = await api.get(`/api/messages/${id}`);
	expect(response.ok(), await response.text()).toBe(true);
	const { message } = (await response.json()) as { message: StoredState };
	return { folderId: message.folderId, read: message.read, status: message.status };
}

type ActivityRow = {
	id: string;
	action: string;
	status: string;
	undoOf: string | null;
	after: Record<string, unknown>;
};

async function activity(mailboxId: string): Promise<ActivityRow[]> {
	const response = await api.get(`/api/agent/actions?mailboxId=${encodeURIComponent(mailboxId)}`);
	expect(response.ok(), await response.text()).toBe(true);
	return ((await response.json()) as { actions: ActivityRow[] }).actions;
}

async function deliver(label: string) {
	return deliverInbound(api, {
		from: "sender@outside.test",
		to: SUPPORT_ADDRESS,
		subject: `${label} ${uniqueToken()}`,
	});
}

async function openPanel(page: Page, mailboxId: string) {
	await selectMailbox(page, mailboxId);
	await page.addInitScript(() => localStorage.setItem("kite-assistant-layout", "floating"));
	return openAssistantPanel(page);
}

test.describe("assistant chat organizes mail through approval and undo", () => {
	test("filing emails into a folder waits for approval, shows in Activity and Undo puts them back", async ({
		page,
	}) => {
		const first = await deliver("Folder chat one");
		const second = await deliver("Folder chat two");
		await api.post("/api/messages/bulk", { data: { messageIds: [second.id], action: "archive" } });
		const folderName = `Chat filing ${uniqueToken()}`;
		const created = await api.post("/api/folders", { data: { mailboxId: first.mailboxId, name: folderName } });
		expect(created.ok(), await created.text()).toBe(true);
		const { id: folderId } = (await created.json()) as { id: string };

		const panel = await openPanel(page, first.mailboxId);
		fake.scriptChat(
			{
				toolCalls: [{ name: "move_emails_to_folder", arguments: { emailIds: [first.id, second.id], folderId } }],
			},
			{ content: "Approve the move to file both emails." },
		);
		await askAssistant(page, `File both into ${folderName}`);
		await expect(panel.getByText("Approve the move to file both emails.")).toBeVisible();
		await expect(panel.getByRole("link", { name: first.subject! }).first()).toBeVisible();
		// Nothing moves before the click.
		expect((await messageState(first.id)).folderId).toBeNull();

		await panel.getByRole("button", { name: `Approve move to “${folderName}”` }).click();
		await expect(panel.getByText(`Moved 2 emails to “${folderName}”.`)).toBeVisible();
		expect(await messageState(first.id)).toMatchObject({ folderId, status: "received" });
		expect(await messageState(second.id)).toMatchObject({ folderId, status: "received" });
		const applied = (await activity(first.mailboxId)).find(
			(row) => row.action === "set_folder" && row.after?.folderId === folderId,
		);
		expect(applied?.status).toBe("applied");
		await page.screenshot({ path: test.info().outputPath("chat-folder-move-approved.png") });

		await panel.getByRole("button", { name: "Undo", exact: true }).click();
		await expect(panel.getByText("Undone.", { exact: true })).toBeVisible();
		expect(await messageState(first.id)).toMatchObject({ folderId: null, status: "received" });
		expect(await messageState(second.id)).toMatchObject({ folderId: null, status: "archived" });
		const rows = await activity(first.mailboxId);
		expect(rows.find((row) => row.id === applied!.id)?.status).toBe("undone");
		expect(rows.some((row) => row.undoOf === applied!.id)).toBe(true);

		// The chat keeps the outcome: after a reload the card still says it was undone and offers no Undo.
		await page.reload();
		const reloaded = page.getByRole("region", { name: "Email assistant" });
		const toggle = page.getByRole("button", { name: /^(Open|Close) email assistant$/ });
		if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
		await expect(reloaded.getByText("Undone.", { exact: true })).toBeVisible();
		await expect(reloaded.getByRole("button", { name: "Undo", exact: true })).toHaveCount(0);
	});

	test("marking emails unread waits for approval and Undo marks them read again", async ({ page }) => {
		const message = await deliver("Unread chat");
		await api.post("/api/messages/bulk", { data: { messageIds: [message.id], action: "read" } });
		expect((await messageState(message.id)).read).toBe(true);

		const panel = await openPanel(page, message.mailboxId);
		fake.scriptChat(
			{ toolCalls: [{ name: "mark_emails_unread", arguments: { emailIds: [message.id] } }] },
			{ content: "Approve to mark it unread." },
		);
		await askAssistant(page, "Mark that email unread");
		await expect(panel.getByText("Approve to mark it unread.")).toBeVisible();
		expect((await messageState(message.id)).read).toBe(true);

		await panel.getByRole("button", { name: "Approve mark 1 email as unread" }).click();
		await expect(panel.getByText("Marked 1 email as unread.")).toBeVisible();
		expect((await messageState(message.id)).read).toBe(false);
		const applied = (await activity(message.mailboxId)).find((row) => row.action === "mark_read");
		expect(applied?.status).toBe("applied");

		await panel.getByRole("button", { name: "Undo", exact: true }).click();
		await expect(panel.getByText("Undone.", { exact: true })).toBeVisible();
		expect((await messageState(message.id)).read).toBe(true);
	});

	test("an undo after one email moved again puts back the rest and says how many", async ({ page }) => {
		const first = await deliver("Partial undo one");
		const second = await deliver("Partial undo two");
		const panel = await openPanel(page, first.mailboxId);
		fake.scriptChat(
			{ toolCalls: [{ name: "move_emails", arguments: { emailIds: [first.id, second.id], destination: "archived" } }] },
			{ content: "Approve to archive both." },
		);
		await askAssistant(page, "Archive both");
		await panel.getByRole("button", { name: "Approve move to the archive" }).click();
		await expect(panel.getByText("Moved 2 emails to the archive.")).toBeVisible();
		await api.post("/api/messages/bulk", { data: { messageIds: [second.id], action: "trash" } });

		await panel.getByRole("button", { name: "Undo", exact: true }).click();
		await expect(panel.getByText("Undid 1 of 2; 1 had moved since.", { exact: true })).toBeVisible();
		expect((await messageState(first.id)).status).toBe("received");
		expect((await messageState(second.id)).status).toBe("trash");
	});

	test("a folder proposed in chat is created only on approval and lists afterwards", async ({ page }) => {
		const message = await deliver("Create folder chat");
		const name = `Chat folder ${uniqueToken()}`;
		const panel = await openPanel(page, message.mailboxId);
		fake.scriptChat(
			{ toolCalls: [{ name: "create_folder", arguments: { name, color: "green" } }] },
			{ content: "Approve the new folder." },
		);
		await askAssistant(page, `Make a folder called ${name}`);
		await expect(panel.getByText("Approve the new folder.")).toBeVisible();
		const listFolders = async () =>
			(
				(await (await api.get(`/api/folders?mailboxId=${message.mailboxId}`)).json()) as {
					folders: { name: string; color: string }[];
				}
			).folders;
		expect((await listFolders()).some((folder) => folder.name === name)).toBe(false);

		await panel.getByRole("button", { name: `Approve new folder “${name}”` }).click();
		await expect(panel.getByText(`Created folder “${name}”.`)).toBeVisible();
		expect((await listFolders()).find((folder) => folder.name === name)?.color).toBe("#16a34a");
		// The sidebar refreshes without switching mailboxes or reloading.
		const nav = page.getByRole("navigation").first();
		await expect(nav.getByRole("link", { name })).toBeVisible();

		await panel.getByRole("button", { name: "Undo", exact: true }).click();
		await expect(panel.getByText("Undone.", { exact: true })).toBeVisible();
		expect((await listFolders()).some((folder) => folder.name === name)).toBe(false);
		await expect(nav.getByRole("link", { name })).toHaveCount(0);
	});
});

test.describe("the external-provider opt-in covers chat", () => {
	test("chat is off with a notice until the primary admin allows the external provider", async ({ page }) => {
		const mailboxId = await firstMailboxId(api);
		const allow = async (externalAutoReadAllowed: boolean) => {
			const response = await api.put("/api/admin/agent", { data: { externalAutoReadAllowed } });
			expect(response.ok(), await response.text()).toBe(true);
		};
		await allow(false);
		try {
			await selectMailbox(page, mailboxId);
			await page.addInitScript(() => localStorage.setItem("kite-assistant-layout", "floating"));
			await page.goto("/inbox");
			const toggle = page.getByRole("button", { name: /^(Open|Close) email assistant$/ });
			if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
			const panel = page.getByRole("region", { name: "Email assistant" });
			const notice = panel.getByTestId("external-provider-notice");
			await expect(notice).toContainText(
				/an external AI provider\. The primary admin hasn.t allowed sending mail to it/,
			);
			await expect(notice.getByRole("link", { name: "Allow it in Admin → Agent" })).toHaveAttribute(
				"href",
				"/agent#automatic-reading",
			);
			await expect(panel.getByRole("textbox", { name: "Message Kite AI" })).toBeDisabled();

			fake.clearRequests();
			const refused = await api.post("/api/agent/chat", { data: { mailboxId, text: "Hello" } });
			expect(refused.status()).toBe(403);
			expect(await refused.json()).toMatchObject({ code: "external_provider_not_allowed" });
			expect(chatRequests(fake)).toHaveLength(0);
		} finally {
			await allow(true);
		}
		await page.reload();
		const panel = await openAssistantPanel(page);
		await expect(panel.getByTestId("external-provider-notice")).toHaveCount(0);
	});
});
