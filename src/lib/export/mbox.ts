import { and, asc, eq, gt, or, type SQL } from "drizzle-orm";
import { getDb, type AppDatabase } from "@/db";
import { messages } from "@/db/schema";
import { loadMessageBodies } from "@/lib/email/bodies";
import { visibleDraftsCondition } from "@/lib/messages/mailbox-scope";
import { bodyBytesColumn, withStoredBodies } from "@/lib/messages/body-batches";

function escapeHeader(value: string | null): string {
	return (value ?? "").replace(/\r?\n/g, " ").trim();
}

function escapeMboxBody(value: string): string {
	return value.replace(/\nFrom /g, "\n>From ");
}

/** Messages whose metadata is listed per query; the rows carry no bodies, so a page stays small. */
const LIST_PAGE = 100;

type StoredMessage = Pick<
	typeof messages.$inferSelect,
	| "id"
	| "fromAddr"
	| "toAddr"
	| "ccAddr"
	| "inReplyTo"
	| "references"
	| "subject"
	| "providerMessageId"
	| "direction"
	| "status"
	| "createdAt"
	| "textBody"
	| "htmlBody"
>;

function getMboxFromLine(date: Date): string {
	return `From MAILER-DAEMON ${date.toUTCString()}`;
}

/** The next page of message metadata after `after`, oldest first. */
function listPage(db: AppDatabase, scope: SQL | undefined, after: { createdAt: Date; id: string } | null) {
	return db
		.select({
			id: messages.id,
			fromAddr: messages.fromAddr,
			toAddr: messages.toAddr,
			ccAddr: messages.ccAddr,
			inReplyTo: messages.inReplyTo,
			references: messages.references,
			subject: messages.subject,
			providerMessageId: messages.providerMessageId,
			direction: messages.direction,
			status: messages.status,
			createdAt: messages.createdAt,
			bodyBytes: bodyBytesColumn,
		})
		.from(messages)
		.where(
			after
				? and(
						scope,
						or(
							gt(messages.createdAt, after.createdAt),
							and(eq(messages.createdAt, after.createdAt), gt(messages.id, after.id)),
						),
					)
				: scope,
		)
		.orderBy(asc(messages.createdAt), asc(messages.id))
		.limit(LIST_PAGE);
}

/**
 * The mailbox as an mbox file. An offloaded body that cannot be read fails the whole export
 * (`MessageBodyUnavailableError`) rather than leaving that message as text in a file the user keeps.
 */
export async function exportMailboxToMbox(env: CloudflareEnv, mailboxId: string, viewerId: string): Promise<string> {
	const db = getDb(env);
	// Drafts go along only for their author.
	const scope = and(eq(messages.mailboxId, mailboxId), visibleDraftsCondition(viewerId));
	const rows: StoredMessage[] = [];
	// D1 fails a query whose result passes 50 MB, so the mailbox is read in pages of metadata, then the
	// bodies of each page in byte-bounded batches, instead of one query holding every body.
	let after: { createdAt: Date; id: string } | null = null;
	while (true) {
		const page: Awaited<ReturnType<typeof listPage>> = await listPage(db, scope, after);
		const loaded = await withStoredBodies(db, page);
		rows.push(...(await loadMessageBodies(env, loaded, { strict: true })));
		if (page.length < LIST_PAGE) break;
		after = page[page.length - 1];
	}

	return rows
		.map((message) => {
			const date = new Date(message.createdAt);
			const body = message.htmlBody ?? message.textBody ?? "";
			const contentType = message.htmlBody ? "text/html" : "text/plain";
			return [
				getMboxFromLine(date),
				`Message-ID: ${escapeHeader(message.providerMessageId || `<${message.id}@kite.local>`)}`,
				`Date: ${date.toUTCString()}`,
				`From: ${escapeHeader(message.fromAddr)}`,
				`To: ${escapeHeader(message.toAddr)}`,
				...(message.ccAddr ? [`Cc: ${escapeHeader(message.ccAddr)}`] : []),
				...(message.inReplyTo ? [`In-Reply-To: <${escapeHeader(message.inReplyTo)}>`] : []),
				...(message.references
					? [
							`References: ${message.references
								.split(/\s+/)
								.filter(Boolean)
								.map((id) => `<${id}>`)
								.join(" ")}`,
						]
					: []),
				`Subject: ${escapeHeader(message.subject)}`,
				`X-Kite-Direction: ${escapeHeader(message.direction)}`,
				`X-Kite-Status: ${escapeHeader(message.status)}`,
				"MIME-Version: 1.0",
				`Content-Type: ${contentType}; charset=utf-8`,
				"Content-Transfer-Encoding: 8bit",
				"",
				escapeMboxBody(body),
				"",
			].join("\r\n");
		})
		.join("\r\n");
}
