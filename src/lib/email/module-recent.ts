import { and, desc, eq, gte, lt, ne, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { messages } from "@/db/schema";
import { SCREENING_STATUS } from "@/lib/screener/screener-utils";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import type { HostMessageView, HostRecentFromSenderQuery } from "@/lib/modules/host-types";
import {
	containsPattern,
	isFromSender,
	RECENT_EXCERPT_BYTES,
	recentBounds,
	utf8Excerpt,
} from "@/lib/modules/host-utils";
import type { CapabilityCallContext } from "@/lib/modules/module-types";
import { actingUser, attachmentsByMessage, readableBody, toHostMessageView } from "./module-read";

/** Candidates read per call; a `from` match on the address inside another one is dropped after reading. */
const CANDIDATE_ROWS = 25;

/**
 * Earlier received messages from one sender in one mailbox, newest first, each with a body excerpt.
 * The mailbox must be one the call is bound to (`ctx.mailboxIds`) and readable by the viewer;
 * otherwise, or for an unusable query, the answer is empty.
 */
export async function recentModuleMessagesFromSender(
	env: CloudflareEnv,
	ctx: CapabilityCallContext,
	query: HostRecentFromSenderQuery,
): Promise<(HostMessageView & { textExcerpt: string | null })[]> {
	const user = actingUser(ctx);
	const bounds = recentBounds(query);
	if (!bounds || !ctx.mailboxIds?.includes(query.mailboxId)) return [];
	const db = getDb(env);
	if (!(await getMailboxAccessLevel(db, user, query.mailboxId))?.canRead) return [];
	const rows = await db
		.select()
		.from(messages)
		.where(
			and(
				eq(messages.mailboxId, query.mailboxId),
				eq(messages.direction, "inbound"),
				ne(messages.status, SCREENING_STATUS),
				lt(messages.createdAt, bounds.before),
				gte(messages.createdAt, bounds.since),
				sql`lower(${messages.fromAddr}) LIKE ${containsPattern(bounds.sender)} ESCAPE '\\'`,
			),
		)
		.orderBy(desc(messages.createdAt), desc(sql`"messages"."rowid"`))
		.limit(CANDIDATE_ROWS);
	const matches = rows.filter((row) => isFromSender(row.fromAddr, bounds.sender)).slice(0, bounds.limit);
	const attachments = await attachmentsByMessage(
		env,
		matches.map((row) => row.id),
	);
	return matches.map((row) => ({
		...toHostMessageView({ ...row, mailboxId: query.mailboxId }, attachments.get(row.id) ?? []),
		textExcerpt: utf8Excerpt(readableBody(row), RECENT_EXCERPT_BYTES),
	}));
}
