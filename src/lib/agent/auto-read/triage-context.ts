import { and, asc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { messageAttachments, messages } from "@/db/schema";
import { htmlToReadableText } from "@/lib/email/reply-content-utils";
import { readRawHeaders } from "@/lib/email/raw-headers";
import { collectFacts } from "./facts-utils";
import type { MessageFacts } from "./facts-types";
import { loadTrustedContacts } from "./trusted-contacts";

type SourceMessage = typeof messages.$inferSelect;

const THREAD_WINDOW = 20;

export type TriageContext = {
	source: SourceMessage;
	facts: MessageFacts;
	/** The raw headers, lower-case names with their first value; empty when the raw message is gone. */
	headers: Record<string, string>;
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
 * on the row), attachments, and the mailbox owner's manual or outbound contacts for spoofing
 * checks. Mailbox contacts live under the owner even when a delegated reviewer triages.
 */
export async function loadTriageContext(
	env: CloudflareEnv,
	source: SourceMessage,
	ownerUserId: string,
): Promise<TriageContext> {
	const db = getDb(env);
	const sender = collectFacts({ message: source });
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
		loadTrustedContacts(db, ownerUserId, { address: sender.senderAddress, name: sender.senderName }),
		threadRows(env, source),
	]);
	const bodyText = source.textBody || htmlToReadableText(source.htmlBody);
	const facts = collectFacts({ message: source, headers, attachments, bodyText, contacts: trustedContacts });
	return {
		source,
		facts,
		headers,
		bodyText,
		threadSubjects: thread.filter((row) => row.id !== source.id).map((row) => row.subject ?? ""),
		threadMessageCount: Math.max(1, thread.length),
	};
}
