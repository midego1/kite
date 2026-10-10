import { and, asc, eq, ne } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts, messageAttachments, messages } from "@/db/schema";
import { htmlToReadableText } from "@/lib/email/reply-content-utils";
import { readRawHeaders } from "@/lib/email/raw-headers";
import { collectFacts } from "./facts-utils";
import type { MessageFacts } from "./facts-types";

type SourceMessage = typeof messages.$inferSelect;

const THREAD_WINDOW = 20;
const CONTACTS_WINDOW = 1_000;

export type TriageContext = {
	source: SourceMessage;
	facts: MessageFacts;
	bodyText: string;
	threadSubjects: string[];
	threadMessageCount: number;
};

async function threadRows(env: CloudflareEnv, source: SourceMessage) {
	if (!source.threadId || !source.mailboxId) return [source];
	return getDb(env)
		.select({ id: messages.id, subject: messages.subject })
		.from(messages)
		.where(and(eq(messages.mailboxId, source.mailboxId), eq(messages.threadId, source.threadId)))
		.orderBy(asc(messages.createdAt))
		.limit(THREAD_WINDOW);
}

/**
 * Everything triage reads about a message: the stored row, its raw headers (headers are not kept
 * on the row), attachments, and the reviewer's own manual or outbound contacts for spoofing checks.
 */
export async function loadTriageContext(
	env: CloudflareEnv,
	source: SourceMessage,
	reviewerUserId: string,
): Promise<TriageContext> {
	const db = getDb(env);
	const [headers, attachments, trustedContacts, thread] = await Promise.all([
		readRawHeaders(env, source.rawR2Key),
		db
			.select({
				filename: messageAttachments.filename,
				contentType: messageAttachments.contentType,
				size: messageAttachments.size,
			})
			.from(messageAttachments)
			.where(eq(messageAttachments.messageId, source.id)),
		db
			.select({ email: contacts.email, displayName: contacts.displayName, source: contacts.source })
			.from(contacts)
			.where(and(eq(contacts.userId, reviewerUserId), ne(contacts.source, "inbound")))
			.limit(CONTACTS_WINDOW),
		threadRows(env, source),
	]);
	const bodyText = source.textBody || htmlToReadableText(source.htmlBody);
	const facts = collectFacts({ message: source, headers, attachments, bodyText, contacts: trustedContacts });
	return {
		source,
		facts,
		bodyText,
		threadSubjects: thread.filter((row) => row.id !== source.id).map((row) => row.subject ?? ""),
		threadMessageCount: Math.max(1, thread.length),
	};
}
