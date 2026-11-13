import { and, eq, gt } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLogs } from "@/db/schema";
import { newId } from "@/lib/ids";
import {
	attemptOutcome,
	decideOneClickAttempt,
	MESSAGE_COOLDOWN_MS,
	UNSUBSCRIBE_ONE_CLICK_ACTION,
} from "@/lib/email/one-click-attempts-utils";

type OneClickAttempt =
	{ allowed: true; id: string } | { allowed: false; id: string; reason: "duplicate" | "rate_limited" };

/**
 * Claims one one-click request with a `pending` audit row and answers whether it may go out (`decideOneClickAttempt`):
 * not while an earlier request by the same user for the same message is pending or reached the sender within ten
 * minutes, nor past ten requests a minute. The row is written first and the user's recent rows read afterwards,
 * including it, so of parallel requests exactly the earliest goes out. It needs no rate-limit binding and fails
 * closed: when the row cannot be written or read this throws and the caller refuses. A refused request keeps its row,
 * marked with the reason, which then counts against nothing; the metadata never holds the link.
 */
export async function recordOneClickAttempt(
	env: CloudflareEnv,
	input: { userId: string; mailboxId: string; messageId: string },
): Promise<OneClickAttempt> {
	const db = getDb(env);
	const id = newId("aud");
	await db.insert(auditLogs).values({
		id,
		actorUserId: input.userId,
		mailboxId: input.mailboxId,
		messageId: input.messageId,
		action: UNSUBSCRIBE_ONE_CLICK_ACTION,
		metadata: JSON.stringify({ outcome: "pending" }),
	});
	const now = Date.now();
	const rows = await db
		.select({
			id: auditLogs.id,
			messageId: auditLogs.messageId,
			createdAt: auditLogs.createdAt,
			metadata: auditLogs.metadata,
		})
		.from(auditLogs)
		.where(
			and(
				eq(auditLogs.actorUserId, input.userId),
				eq(auditLogs.action, UNSUBSCRIBE_ONE_CLICK_ACTION),
				// Whole seconds are stored: one more second keeps a row written in this second's start.
				gt(auditLogs.createdAt, new Date(now - MESSAGE_COOLDOWN_MS - 1000)),
			),
		);
	const reason = decideOneClickAttempt(
		rows.map((row) => ({
			id: row.id,
			messageId: row.messageId,
			createdAt: row.createdAt.getTime(),
			outcome: attemptOutcome(row.metadata),
		})),
		{ id, messageId: input.messageId },
		now,
	);
	if (!reason) return { allowed: true, id };
	await completeOneClickAttempt(env, id, { outcome: reason });
	return { allowed: false, id, reason };
}

/** Writes the outcome onto the request's own row. Never the link, which usually identifies the recipient. */
export async function completeOneClickAttempt(
	env: CloudflareEnv,
	id: string,
	metadata: { outcome: string; status?: number },
): Promise<void> {
	await getDb(env)
		.update(auditLogs)
		.set({ metadata: JSON.stringify(metadata) })
		.where(eq(auditLogs.id, id));
}
