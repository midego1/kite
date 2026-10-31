import { and, asc, eq, inArray, or, sql, type Column } from "drizzle-orm";
import type { getDb } from "@/db";
import { messages } from "@/db/schema";
import { newId } from "@/lib/ids";
import type { ResolveThreadInput } from "@/lib/email/threading-types";
import { normalizeMessageId, selectThreadLookupIds } from "@/lib/email/thread-lookup";
import { isThreadParticipant } from "@/lib/email/thread-join-utils";
import { normalizeEmailAddress } from "@/lib/email/address";

export { normalizeMessageId } from "@/lib/email/thread-lookup";

type Db = ReturnType<typeof getDb>;

/** A References header is a whitespace (occasionally comma) separated list of Message-IDs. */
export function parseMessageIdList(value: string | null | undefined): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const token of (value ?? "").split(/[\s,]+/)) {
		const id = normalizeMessageId(token);
		if (!id || seen.has(id)) continue;
		seen.add(id);
		result.push(id);
	}
	return result;
}

export function formatMessageIdHeader(ids: string[]): string {
	return ids.map((id) => `<${id}>`).join(" ");
}

/**
 * The References line a reply should carry: the parent's own chain followed by
 * the parent itself. Long chains keep the root and the most recent ancestors,
 * which is what mail clients use to reconstruct a conversation.
 */
export function buildReplyReferences(parentReferences: string[], parentMessageId: string | null): string[] {
	const ids = [...parentReferences];
	const parent = normalizeMessageId(parentMessageId);
	if (parent && !ids.includes(parent)) ids.push(parent);
	const MAX = 30;
	if (ids.length <= MAX) return ids;
	return [ids[0], ...ids.slice(ids.length - (MAX - 1))];
}

/**
 * Work out which conversation a message belongs to. A reply names its parent in
 * In-Reply-To or References; if that parent is stored in the same mailbox, the
 * new message joins the parent's thread. Otherwise it starts a thread keyed by
 * its own Message-ID so later replies can find it.
 *
 * Those headers are the sender's to write, so received mail (`input.sender`) joins
 * a conversation only when it passed DMARC for its From domain, or when DMARC did
 * not fail and its sender already takes part in the conversation; a failed DMARC
 * check always starts a new one, since the From may be forged. It never seeds a
 * thread with a Message-ID that is already a thread's key, except the copy of the
 * mailbox's own sent message (a send to itself or one of its aliases) (upstream
 * Mailflare #223). Imports, synced mail and JMAP drafts are the user's own history
 * and keep joining on the headers alone.
 */
export async function resolveThreadId(db: Db, input: ResolveThreadInput): Promise<string> {
	const candidates = selectThreadLookupIds(input.inReplyTo, input.references ?? []);

	if (input.mailboxId && candidates.length > 0) {
		// Stored Message-IDs may or may not include their angle brackets.
		const variants = candidates.flatMap((id) => [id, `<${id}>`]);
		const [parent] = await db
			.select({ id: messages.id, threadId: messages.threadId, providerMessageId: messages.providerMessageId })
			.from(messages)
			.where(and(eq(messages.mailboxId, input.mailboxId), inArray(messages.providerMessageId, variants)))
			.orderBy(asc(messages.createdAt))
			.limit(1);
		if (parent) {
			const threadId = parent.threadId ?? normalizeMessageId(parent.providerMessageId) ?? newId("thr");
			if (!input.sender || input.sender.dmarc === "pass") return threadId;
			if (input.sender.dmarc === "fail") return newId("thr");
			return (await senderTakesPart(db, input.mailboxId, parent.id, threadId, input.sender.address))
				? threadId
				: newId("thr");
		}
	}

	const seed = threadSeed(input);
	if (!seed || !input.sender || !input.mailboxId || !(await isThreadKey(db, input.mailboxId, seed)))
		return seed ?? newId("thr");
	return (await isOwnSentCopy(db, input.mailboxId, seed, input.sender)) ? seed : newId("thr");
}

/** A `LIKE … ESCAPE '\'` pattern matching `value` anywhere, with `%`, `_` and `\` taken literally. */
function likeContains(value: string): string {
	return `%${value.replace(/[%_\\]/g, (char) => `\\${char}`)}%`;
}

/**
 * Whether `address` sent, received or was copied on a message of the conversation (the parent itself included, for
 * rows stored before threads had ids). `LIKE` only narrows the rows; whole addresses are compared in code.
 */
async function senderTakesPart(
	db: Db,
	mailboxId: string,
	parentId: string,
	threadId: string,
	address: string,
): Promise<boolean> {
	const bare = normalizeEmailAddress(address);
	if (!bare) return false;
	const pattern = likeContains(bare);
	const mentions = (column: Column) => sql`lower(${column}) LIKE ${pattern} ESCAPE '\\'`;
	const rows = await db
		.select({
			fromAddr: messages.fromAddr,
			toAddr: messages.toAddr,
			ccAddr: messages.ccAddr,
			bccAddr: messages.bccAddr,
		})
		.from(messages)
		.where(
			and(
				eq(messages.mailboxId, mailboxId),
				or(eq(messages.threadId, threadId), eq(messages.id, parentId)),
				or(
					mentions(messages.fromAddr),
					mentions(messages.toAddr),
					mentions(messages.ccAddr),
					mentions(messages.bccAddr),
				),
			),
		)
		.limit(200);
	return isThreadParticipant(bare, rows);
}

/**
 * Whether received mail whose Message-ID keys a thread is the copy of a message this mailbox sent itself: an outbound
 * row of the mailbox carries that Message-ID and keys that thread with it, its From is the same address, and DMARC did
 * not fail. A send to the mailbox's own address or alias comes back this way and belongs with the sent message.
 */
async function isOwnSentCopy(
	db: Db,
	mailboxId: string,
	messageId: string,
	sender: NonNullable<ResolveThreadInput["sender"]>,
): Promise<boolean> {
	const address = normalizeEmailAddress(sender.address);
	if (sender.dmarc === "fail" || !address) return false;
	const sent = await db
		.select({ fromAddr: messages.fromAddr })
		.from(messages)
		.where(
			and(
				eq(messages.mailboxId, mailboxId),
				eq(messages.direction, "outbound"),
				eq(messages.threadId, messageId),
				inArray(messages.providerMessageId, [messageId, `<${messageId}>`]),
			),
		)
		.limit(5);
	return sent.some((row) => normalizeEmailAddress(row.fromAddr) === address);
}

/** Whether a conversation of the mailbox already uses `threadId` as its key. */
async function isThreadKey(db: Db, mailboxId: string, threadId: string): Promise<boolean> {
	const [taken] = await db
		.select({ id: messages.id })
		.from(messages)
		.where(and(eq(messages.mailboxId, mailboxId), eq(messages.threadId, threadId)))
		.limit(1);
	return !!taken;
}

/**
 * @public Exercised by the unit tests. The thread key of a message with no stored parent: its own Message-ID, or
 * the conversation root's for imports.
 */
export function threadSeed(input: ResolveThreadInput): string | null {
	const own = normalizeMessageId(input.messageId);
	if (input.fallback !== "references-root") return own;
	return normalizeMessageId(input.references?.[0]) ?? normalizeMessageId(input.inReplyTo) ?? own;
}
