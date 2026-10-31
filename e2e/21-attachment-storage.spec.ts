import { randomBytes } from "node:crypto";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { STORAGE_STATE, SUPPORT_ADDRESS } from "./support/constants";
import { apiContext, deliverInbound, setSendingSettings, uniqueToken } from "./support/helpers";

// docs/specs/attachments-once.md §8 step 3: a send from a draft and a forward share the stored object instead of
// copying it, and a delete removes an object only once no row names it any more.

type Attachment = { id: string; filename: string; size: number };
type Verification = { checked: number; missing: { key: string; messageIds: string[] }[] };
type Report = { objects: { rows: number; keys: number; bytes: number; storedBytes: number } };

/** A PDF-looking file with random content, so a byte-exact comparison means something. */
function pdfFixture(): Buffer {
	return Buffer.concat([Buffer.from("%PDF-1.4\n"), randomBytes(48 * 1024), Buffer.from("\n%%EOF\n")]);
}

async function json<T>(response: Awaited<ReturnType<APIRequestContext["get"]>>): Promise<T> {
	expect(response.ok(), `${response.url()}: ${await response.text()}`).toBe(true);
	return (await response.json()) as T;
}

async function attachmentsOf(api: APIRequestContext, messageId: string): Promise<Attachment[]> {
	return (await json<{ attachments: Attachment[] }>(await api.get(`/api/messages/${messageId}`))).attachments;
}

async function download(api: APIRequestContext, messageId: string, attachmentId: string): Promise<Buffer> {
	const response = await api.get(`/api/messages/${messageId}/attachments/${attachmentId}?download=1`);
	expect(response.status(), response.url()).toBe(200);
	return response.body();
}

async function supportMailboxId(api: APIRequestContext): Promise<string> {
	const { mailboxes } = await json<{ mailboxes: { id: string; localPart: string; hostname: string }[] }>(
		await api.get("/api/mailboxes"),
	);
	const mailbox = mailboxes.find((item) => `${item.localPart}@${item.hostname}` === SUPPORT_ADDRESS);
	expect(mailbox, SUPPORT_ADDRESS).toBeDefined();
	return mailbox!.id;
}

async function createDraft(api: APIRequestContext, data: Record<string, unknown>) {
	return (
		await json<{ draft: { id: string; attachments: Attachment[] } }>(
			await api.post("/api/drafts", { data: { from: SUPPORT_ADDRESS, to: "reader@outside.test", ...data } }),
		)
	).draft;
}

async function objectCounts(api: APIRequestContext): Promise<Report["objects"]> {
	return (await json<Report>(await api.get("/api/admin/attachment-storage"))).objects;
}

async function verifyObjects(api: APIRequestContext): Promise<Verification> {
	return (await json<{ verify: Verification }>(await api.get("/api/admin/attachment-storage?verify=1"))).verify;
}

/** Moves messages to Trash and then deletes them forever, the way the Trash folder's bulk delete does. */
async function deleteForever(api: APIRequestContext, messageIds: string[]) {
	await json(await api.post("/api/messages/bulk", { data: { action: "trash", messageIds } }));
	const deleted = await json<{ deleted: number }>(
		await api.post("/api/messages/bulk", { data: { action: "delete", messageIds } }),
	);
	expect(deleted.deleted).toBe(messageIds.length);
}

test.describe.configure({ mode: "serial" });

test("sent and forwarded files share their object and survive deleting the draft", async () => {
	const api = await apiContext(STORAGE_STATE);
	await setSendingSettings(api, { previewEnabled: false, undoSeconds: 0 });
	const mailboxId = await supportMailboxId(api);
	const token = uniqueToken();

	// Upload to a draft, send it, then delete the draft as the composer does: the Sent copy still downloads.
	const uploaded = pdfFixture();
	const beforeSend = await objectCounts(api);
	const draft = await createDraft(api, { mailboxId, subject: `Shared upload ${token}`, text: "See the file." });
	const stored = await json<{ attachments: Attachment[] }>(
		await api.post(`/api/drafts/${draft.id}/attachments`, {
			multipart: { attachments: { name: "plan.pdf", mimeType: "application/pdf", buffer: uploaded } },
		}),
	);
	expect(stored.attachments).toHaveLength(1);
	const sent = await json<{ messageId: string }>(
		await api.post("/api/send", {
			data: {
				from: SUPPORT_ADDRESS,
				to: "reader@outside.test",
				subject: `Shared upload ${token}`,
				text: "See the file.",
				mailboxId,
				draftId: draft.id,
			},
		}),
	);
	// The draft and the Sent copy are two rows naming one object.
	const afterSend = await objectCounts(api);
	expect([afterSend.rows - beforeSend.rows, afterSend.keys - beforeSend.keys]).toEqual([2, 1]);
	await json(await api.delete(`/api/drafts/${draft.id}`));
	const [sentFile] = await attachmentsOf(api, sent.messageId);
	expect(sentFile).toMatchObject({ filename: "plan.pdf", size: uploaded.length });
	expect((await download(api, sent.messageId, sentFile.id)).equals(uploaded)).toBe(true);

	// Forward a received message with a stored file, then delete the forward draft: the original still downloads.
	const received = pdfFixture();
	const original = await deliverInbound(api, {
		from: `"File Sender" <files@outside.test>`,
		to: SUPPORT_ADDRESS,
		subject: `Shared forward ${token}`,
		text: "Here is the report.",
		attachments: [{ filename: "report.pdf", contentType: "application/pdf", content: received }],
	});
	const [originalFile] = await attachmentsOf(api, original.id);
	const beforeForward = await objectCounts(api);
	const forward = await createDraft(api, {
		mailboxId,
		subject: `Fwd: Shared forward ${token}`,
		forwardOfMessageId: original.id,
	});
	expect(forward.attachments).toMatchObject([{ filename: "report.pdf", size: received.length }]);
	const afterForward = await objectCounts(api);
	expect([afterForward.rows - beforeForward.rows, afterForward.keys - beforeForward.keys]).toEqual([1, 0]);
	expect((await download(api, forward.id, forward.attachments[0].id)).equals(received)).toBe(true);
	await json(await api.delete(`/api/drafts/${forward.id}`));
	expect((await download(api, original.id, originalFile.id)).equals(received)).toBe(true);

	const ours = [sent.messageId, original.id];
	const before = await verifyObjects(api);
	expect(before.missing.filter((entry) => entry.messageIds.some((id) => ours.includes(id)))).toEqual([]);

	// Deleting both forever takes their objects; nothing another message still names goes missing.
	await expect
		.poll(
			async () =>
				(await json<{ message: { status: string } }>(await api.get(`/api/messages/${sent.messageId}`))).message.status,
		)
		.toBe("sent");
	await deleteForever(api, ours);
	expect((await api.get(`/api/messages/${original.id}/attachments/${originalFile.id}`)).status()).toBe(404);
	const after = await verifyObjects(api);
	expect(after.missing).toEqual([]);
	await api.dispose();
});

test("the storage report is for admins only", async () => {
	const anonymous = await apiContext();
	expect((await anonymous.get("/api/admin/attachment-storage")).status()).toBe(401);
	await anonymous.dispose();
	const api = await apiContext(STORAGE_STATE);
	const objects = await objectCounts(api);
	expect(objects.keys).toBeLessThanOrEqual(objects.rows);
	expect(objects.storedBytes).toBeLessThanOrEqual(objects.bytes);
	await api.dispose();
});
