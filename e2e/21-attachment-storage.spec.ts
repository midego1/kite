import { createHash, randomBytes } from "node:crypto";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { createSignedInAccount } from "./support/auto-read";
import { STORAGE_STATE, SUPPORT_ADDRESS } from "./support/constants";
import { apiContext, buildMime, deliverInbound, openMessage, setSendingSettings, uniqueToken } from "./support/helpers";

// docs/specs/attachments-once.md §8 step 3: a send from a draft and a forward share the stored object instead of
// copying it, and a delete removes an object only once no row names it any more.

type Attachment = { id: string; filename: string; size: number };
type Verification = { checked: number; missing: { key: string; messageIds: string[] }[] };
type Report = {
	objects: { rows: number; keys: number; bytes: number; storedBytes: number };
	raw: { rows: number; bytes: number };
};

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

async function storageCounts(api: APIRequestContext): Promise<Report> {
	return json<Report>(await api.get("/api/admin/attachment-storage"));
}

async function objectCounts(api: APIRequestContext): Promise<Report["objects"]> {
	return (await storageCounts(api)).objects;
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

/** A 2×2 PNG, so the reader has a real image to decode. */
const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAF0lEQVR4nGNQTX79//9/hv///6smvwYAPKII4TwRI+AAAAAASUVORK5CYII=",
	"base64",
);
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** A JMAP client for the support mailbox: the session's download URL and a method caller. */
async function jmapClient(api: APIRequestContext, mailboxId: string) {
	const created = await json<{ id: string; key: string }>(
		await api.post("/api/api-keys", { data: { name: uniqueToken("jmap"), scopes: ["jmap"], mailboxIds: [mailboxId] } }),
	);
	const client = await apiContext();
	const headers = { Authorization: `Bearer ${created.key}` };
	const session = await json<{ primaryAccounts: Record<string, string>; downloadUrl: string }>(
		await client.get("/jmap/session", { headers }),
	);
	const accountId = session.primaryAccounts["urn:ietf:params:jmap:mail"];
	const using = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"];
	return {
		accountId,
		call: async (methodCalls: unknown[]) =>
			(
				await json<{ methodResponses: [string, Record<string, unknown>, string][] }>(
					await client.post("/jmap/api", { headers, data: { using, methodCalls } }),
				)
			).methodResponses,
		download: async (blobId: string) => {
			const url = session.downloadUrl
				.replace("{accountId}", encodeURIComponent(accountId))
				.replace("{blobId}", encodeURIComponent(blobId))
				.replace("{name}", "blob")
				.replace("{type}", "application/octet-stream");
			const response = await client.get(url, { headers });
			expect(response.status(), url).toBe(200);
			return response.body();
		},
		close: async () => {
			await api.delete(`/api/api-keys?id=${encodeURIComponent(created.id)}`);
			await client.dispose();
		},
	};
}

// docs/specs/attachments-once.md §8 step 4: received files are served from the raw message, with no copy of their own.
test("received files are served from their raw message, byte-exact on every read path", async ({ page }) => {
	const api = await apiContext(STORAGE_STATE);
	await setSendingSettings(api, { previewEnabled: false, undoSeconds: 0 });
	const mailboxId = await supportMailboxId(api);
	const token = uniqueToken();
	const pdf = pdfFixture();
	const subject = `Raw files ${token}`;
	const mail = {
		from: `"Raw Sender" <raw-files@outside.test>`,
		to: SUPPORT_ADDRESS,
		subject,
		text: "The report and our logo.",
		html: `<p>The report and our logo.</p><img src="cid:logo-${token}@e2e.test" alt="Logo">`,
		related: true,
		attachments: [
			{
				filename: "logo.png",
				contentType: "image/png",
				content: PNG,
				disposition: "inline" as const,
				contentId: `logo-${token}@e2e.test`,
			},
			{ filename: "report.pdf", contentType: "application/pdf", content: pdf },
		],
	};
	const mime = buildMime(mail);
	const before = await storageCounts(api);
	const message = await deliverInbound(api, mail, mime);

	// Both files are 'raw' rows; nothing was written beside the raw message.
	const after = await storageCounts(api);
	expect(after.raw.rows - before.raw.rows).toBe(2);
	expect(after.raw.bytes - before.raw.bytes).toBe(PNG.length + pdf.length);
	expect([after.objects.rows - before.objects.rows, after.objects.keys - before.objects.keys]).toEqual([0, 0]);

	const files = await attachmentsOf(api, message.id);
	const expected = new Map([
		["logo.png", PNG],
		["report.pdf", pdf],
	]);
	expect(files.map((file) => file.filename).sort()).toEqual(["logo.png", "report.pdf"]);
	for (const file of files) {
		const bytes = expected.get(file.filename)!;
		expect(sha256(await download(api, message.id, file.id))).toBe(sha256(bytes));
		const preview = await api.get(`/api/messages/${message.id}/attachments/${file.id}?preview=1`);
		expect(preview.status()).toBe(200);
		expect(sha256(await preview.body())).toBe(sha256(bytes));
	}

	// "Show original" is exactly what was received.
	const original = await api.get(`/api/messages/${message.id}/original`);
	expect(original.status()).toBe(200);
	expect((await original.body()).equals(Buffer.from(mime))).toBe(true);

	// JMAP: the email blob is the received message and each attachment blob its file.
	const jmap = await jmapClient(api, mailboxId);
	try {
		const [[, queried]] = await jmap.call([
			["Email/query", { accountId: jmap.accountId, filter: { subject: token } }, "q"],
		]);
		const ids = queried.ids as string[];
		expect(ids).toHaveLength(1);
		const [[, got]] = await jmap.call([
			[
				"Email/get",
				{ accountId: jmap.accountId, ids, properties: ["blobId", "attachments"], bodyProperties: ["blobId", "name"] },
				"g",
			],
		]);
		const [email] = got.list as { blobId: string; attachments: { blobId: string; name: string }[] }[];
		expect((await jmap.download(email.blobId)).equals(Buffer.from(mime))).toBe(true);
		expect(email.attachments.map((part) => part.name).sort()).toEqual(["logo.png", "report.pdf"]);
		for (const part of email.attachments)
			expect(sha256(await jmap.download(part.blobId))).toBe(sha256(expected.get(part.name)!));
	} finally {
		await jmap.close();
	}

	// A forward carries the exact bytes, and so does the message sent from it.
	const forward = await createDraft(api, { mailboxId, subject: `Fwd: ${subject}`, forwardOfMessageId: message.id });
	expect(forward.attachments.map((file) => file.filename).sort()).toEqual(["logo.png", "report.pdf"]);
	const sent = await json<{ messageId: string }>(
		await api.post("/api/send", {
			data: {
				from: SUPPORT_ADDRESS,
				to: "reader@outside.test",
				subject: `Fwd: ${subject}`,
				text: "Forwarding the report.",
				mailboxId,
				draftId: forward.id,
			},
		}),
	);
	for (const file of await attachmentsOf(api, sent.messageId))
		expect(sha256(await download(api, sent.messageId, file.id))).toBe(sha256(expected.get(file.filename)!));

	// The inline image renders in the reader.
	await page.goto("/inbox");
	await openMessage(page, subject);
	const logo = page.frameLocator('iframe[title="Message body"]').getByRole("img", { name: "Logo" });
	await expect
		.poll(() => logo.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth))
		.toBe(2);
	await api.dispose();
});

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
	// Quoted-printable cannot be served from the raw message, so the received file has an object of its own.
	const received = pdfFixture();
	const original = await deliverInbound(api, {
		from: `"File Sender" <files@outside.test>`,
		to: SUPPORT_ADDRESS,
		subject: `Shared forward ${token}`,
		text: "Here is the report.",
		attachments: [
			{
				filename: "report.pdf",
				contentType: "application/pdf",
				content: received,
				transferEncoding: "quoted-printable",
			},
		],
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
	const beforeDelete = await objectCounts(api);
	await deleteForever(api, ours);
	// The Sent copy's and the original's rows go, and with them their two objects (nothing else named them).
	const afterDelete = await objectCounts(api);
	expect([beforeDelete.rows - afterDelete.rows, beforeDelete.keys - afterDelete.keys]).toEqual([2, 2]);
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
	const member = await createSignedInAccount(api, `st${uniqueToken().slice(-8)}`);
	expect((await member.api.get("/api/admin/attachment-storage?verify=1")).status()).toBe(403);
	await member.api.dispose();
	const objects = await objectCounts(api);
	expect(objects.keys).toBeLessThanOrEqual(objects.rows);
	expect(objects.storedBytes).toBeLessThanOrEqual(objects.bytes);
	await api.dispose();
});
