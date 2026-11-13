import { and, count, eq, gt } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLogs } from "@/db/schema";
import { newId } from "@/lib/ids";

const ACTION = "message.unsubscribe_one_click";
/** One request per user and message in this window: a real unsubscribe needs one. */
const MESSAGE_COOLDOWN_MS = 10 * 60_000;
/** And at most this many per user a minute, whatever the message. */
const USER_ATTEMPTS_PER_MINUTE = 10;

type OneClickAttempt =
	{ allowed: true; id: string } | { allowed: false; id: string; reason: "duplicate" | "rate_limited" };

async function attemptsSince(
	env: CloudflareEnv,
	userId: string,
	since: number,
	messageId: string | null,
): Promise<number> {
	const [row] = await getDb(env)
		.select({ attempts: count() })
		.from(auditLogs)
		.where(
			and(
				eq(auditLogs.actorUserId, userId),
				eq(auditLogs.action, ACTION),
				gt(auditLogs.createdAt, new Date(since)),
				messageId ? eq(auditLogs.messageId, messageId) : undefined,
			),
		);
	return row?.attempts ?? 0;
}

/**
 * Records one one-click request as its audit row and answers whether it may go out: not when the same user already
 * asked for the same message within ten minutes, nor past ten requests a minute. The row is written first and the
 * counts read afterwards, including it, so parallel requests can never all see room (`recordStorageAttempt`). It needs
 * no rate-limit binding and fails closed: when the row cannot be written or counted this throws and the caller
 * refuses. A refused request keeps its row, marked with the reason; the metadata never holds the link.
 */
export async function recordOneClickAttempt(
	env: CloudflareEnv,
	input: { userId: string; mailboxId: string; messageId: string },
): Promise<OneClickAttempt> {
	const id = newId("aud");
	await getDb(env)
		.insert(auditLogs)
		.values({ id, actorUserId: input.userId, mailboxId: input.mailboxId, messageId: input.messageId, action: ACTION });
	const now = Date.now();
	const [forMessage, forUser] = await Promise.all([
		attemptsSince(env, input.userId, now - MESSAGE_COOLDOWN_MS, input.messageId),
		attemptsSince(env, input.userId, now - 60_000, null),
	]);
	const reason = forMessage > 1 ? "duplicate" : forUser > USER_ATTEMPTS_PER_MINUTE ? "rate_limited" : null;
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
