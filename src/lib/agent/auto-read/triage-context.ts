import { and, asc, eq, inArray, ne } from "drizzle-orm";
import { getDb, type AppDatabase } from "@/db";
import { domains, messageAttachments, messages } from "@/db/schema";
import { htmlToReadableText } from "@/lib/email/reply-content-utils";
import { loadMessageBody } from "@/lib/email/bodies";
import { readRawHeaders } from "@/lib/email/raw-headers";
import { hostAndParents, linkHostsOf, summarizeLinks } from "@/lib/spam/analyzers/link-host-utils";
import { htmlLinkText } from "@/lib/spam/tokenizer-utils";
import { DRAFT_STATUS } from "@/lib/messages/draft-privacy-utils";
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
	// Drafts are private to their author, so none of them shapes what automatic reading sees.
	return getDb(env)
		.select({ id: messages.id, subject: messages.subject })
		.from(messages)
		.where(
			and(
				eq(messages.mailboxId, source.mailboxId),
				eq(messages.threadId, source.threadId),
				ne(messages.status, DRAFT_STATUS),
			),
		)
		.orderBy(asc(messages.createdAt))
		.limit(THREAD_WINDOW);
}

/** Whether the sender's domain, or a parent of it, is one of this install's domains. */
async function isOwnDomain(db: AppDatabase, senderAddress: string): Promise<boolean> {
	const at = senderAddress.lastIndexOf("@");
	const names = at >= 0 ? hostAndParents(senderAddress.slice(at + 1)) : [];
	if (names.length === 0) return false;
	const [row] = await db.select({ id: domains.id }).from(domains).where(inArray(domains.hostname, names)).limit(1);
	return !!row;
}

/**
 * Everything triage reads about a message: the stored row, its raw headers (headers are not kept
 * on the row), attachments, and the mailbox owner's manual or outbound contacts for spoofing
 * checks, whether the sender is on one of the install's domains, and the hosts the body links to.
 * Mailbox contacts live under the owner even when a delegated reviewer triages.
 */
export async function loadTriageContext(
	env: CloudflareEnv,
	stored: SourceMessage,
	ownerUserId: string,
): Promise<TriageContext> {
	const db = getDb(env);
	// Link hosts are read from the HTML too, so an offloaded body is read whole.
	const source = await loadMessageBody(env, stored);
	const sender = collectFacts({ message: source });
	const [headers, attachments, trustedContacts, thread, ownDomain] = await Promise.all([
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
		isOwnDomain(db, sender.senderAddress),
	]);
	const bodyText = source.textBody || htmlToReadableText(source.htmlBody);
	const links = summarizeLinks(
		sender.senderAddress,
		linkHostsOf(`${source.textBody ?? ""}\n${source.htmlBody ? htmlLinkText(source.htmlBody) : ""}`),
	);
	const facts = collectFacts({
		message: source,
		headers,
		attachments,
		bodyText,
		contacts: trustedContacts,
		ownDomain,
		links,
	});
	return {
		source,
		facts,
		headers,
		bodyText,
		threadSubjects: thread.filter((row) => row.id !== source.id).map((row) => row.subject ?? ""),
		threadMessageCount: Math.max(1, thread.length),
	};
}
