import { expect, test, type APIRequestContext } from "@playwright/test";
import { STORAGE_STATE } from "./support/constants";
import { apiContext, uniqueToken } from "./support/helpers";

// File uploads carry their own state in their headers (src/lib/import/message-hints-utils.ts): mbox `Status`, Gmail
// Takeout `X-Gmail-Labels` and `X-Spam-Flag`. The hints refine only an upload to the Inbox.

type Row = { subject: string | null; status: string; read: boolean; starred?: boolean };

function message(subject: string, headers: string[]): string {
	return [
		"From: Sam <sam@example.org>",
		"To: user@example.test",
		`Subject: ${subject}`,
		`Message-ID: <${subject}@example.org>`,
		"Date: Tue, 27 Oct 2026 10:00:00 +0000",
		...headers,
		"",
		`Hello ${subject}`,
		"",
	].join("\n");
}

/** One mbox, one message per entry. */
function mbox(messages: string[]): Buffer {
	return Buffer.from(messages.map((text) => `From sam@example.org Tue Oct 27 10:00:00 2026\n${text}`).join("\n"));
}

async function upload(api: APIRequestContext, mailboxId: string, destination: string, file: Buffer) {
	const response = await api.post("/api/import/messages", {
		multipart: { mailboxId, destination, files: { name: "export.mbox", mimeType: "application/mbox", buffer: file } },
		timeout: 60_000,
	});
	expect(response.status(), await response.text()).toBe(200);
	return (await response.json()) as { imported: number; skipped: number; errors: string[] };
}

async function rowsOf(api: APIRequestContext, token: string, status: string): Promise<Row[]> {
	const params = new URLSearchParams({ q: token, status, limit: "50" });
	const response = await api.get(`/api/messages?${params}`);
	expect(response.ok()).toBe(true);
	return ((await response.json()) as { messages: Row[] }).messages;
}

test("an upload to the Inbox keeps the read state and files spam and trash from the message's own headers", async () => {
	test.setTimeout(120_000);
	const token = uniqueToken("hints");
	const api = await apiContext(STORAGE_STATE);
	try {
		const { mailboxes } = (await (await api.get("/api/mailboxes")).json()) as { mailboxes: { id: string }[] };
		const mailboxId = mailboxes[0].id;
		const result = await upload(
			api,
			mailboxId,
			"system:inbox",
			mbox([
				message(`${token}plain`, []),
				message(`${token}statusread`, ["Status: RO"]),
				message(`${token}statusnew`, ["Status: O"]),
				message(`${token}takeoutunread`, ["X-Gmail-Labels: Inbox,Unread"]),
				message(`${token}takeoutread`, ["X-Gmail-Labels: Inbox,Starred"]),
				message(`${token}takeoutspam`, ["X-Gmail-Labels: Spam,Unread"]),
				message(`${token}takeouttrash`, ["X-Gmail-Labels: Trash"]),
				message(`${token}spamflag`, ["X-Spam-Flag: YES"]),
				message(`${token}gmailwins`, ["X-Gmail-Labels: Inbox,Important", "X-Spam-Flag: YES"]),
				message(`${token}localized`, ["X-Gmail-Labels: Posteingang"]),
				message(`${token}hostile`, ["Status: <script>", "X-Spam-Flag: " + "y".repeat(5000)]),
			]),
		);
		expect(result).toMatchObject({ imported: 11, skipped: 0, errors: [] });

		const inbox = await rowsOf(api, token, "received");
		const byName = (rows: Row[], name: string) => rows.find((row) => row.subject === `${token}${name}`);
		expect(inbox.map((row) => row.subject?.slice(token.length)).sort()).toEqual(
			["gmailwins", "hostile", "localized", "plain", "statusnew", "statusread", "takeoutread", "takeoutunread"].sort(),
		);
		expect(byName(inbox, "plain")?.read).toBe(false);
		expect(byName(inbox, "statusread")?.read).toBe(true);
		expect(byName(inbox, "statusnew")?.read).toBe(false);
		expect(byName(inbox, "takeoutunread")?.read).toBe(false);
		expect(byName(inbox, "takeoutread")?.read).toBe(true);
		expect(byName(inbox, "takeoutread")?.starred).toBe(true);
		// Gmail's labels decide placement, not a spam filter's flag; a localized list does not make mail read.
		expect(byName(inbox, "gmailwins")?.read).toBe(true);
		expect(byName(inbox, "localized")?.read).toBe(false);
		// Garbage headers are ignored: the message is imported as it always was.
		expect(byName(inbox, "hostile")?.read).toBe(false);

		const spam = await rowsOf(api, token, "spam");
		expect(spam.map((row) => row.subject?.slice(token.length)).sort()).toEqual(["spamflag", "takeoutspam"]);
		expect(byName(spam, "takeoutspam")?.read).toBe(false);
		expect((await rowsOf(api, token, "trash")).map((row) => row.subject?.slice(token.length))).toEqual([
			"takeouttrash",
		]);
		// Nothing was held by the Screener.
		expect(await rowsOf(api, token, "screening")).toEqual([]);

		// A destination the user picked is kept, whatever the headers say; the read state still follows them.
		const archivedToken = uniqueToken("hintsarch");
		const archived = await upload(
			api,
			mailboxId,
			"system:archived",
			mbox([message(`${archivedToken}a`, ["X-Gmail-Labels: Spam"]), message(`${archivedToken}b`, ["Status: RO"])]),
		);
		expect(archived.imported).toBe(2);
		const kept = await rowsOf(api, archivedToken, "archived");
		expect(kept.map((row) => row.subject).sort()).toEqual([`${archivedToken}a`, `${archivedToken}b`]);
		expect(kept.find((row) => row.subject === `${archivedToken}b`)?.read).toBe(true);
		expect(await rowsOf(api, archivedToken, "spam")).toEqual([]);
	} finally {
		await api.dispose();
	}
});
