import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { messages } from "@/db/schema";
import type { SessionUser } from "@/lib/auth/types";
import { canUseOneClick, storedDkimPassed } from "@/lib/email/mailing-list-utils";
import { isUnsubscribeLoopbackAllowed, postOneClickUnsubscribe } from "@/lib/email/one-click-unsubscribe-utils";
import { getMailingListHeadersFromRawR2Key } from "@/lib/email/unsubscribe";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { isHiddenDraft } from "@/lib/messages/draft-privacy-utils";
import { SCREENING_STATUS } from "@/lib/screener/screener-utils";

type OneClickUnsubscribeResult =
	| { kind: "done" }
	| { kind: "not_found" }
	| { kind: "forbidden" }
	| { kind: "rate_limited" }
	/** The message offers no verified one-click; `url` is the link the reader can still open. */
	| { kind: "unavailable"; url: string | null }
	| { kind: "failed"; url: string | null };

/** Statuses whose mail is never unsubscribed from: confirming a spam address is live, or mail not yet let in. */
const REFUSED_STATUSES = new Set(["spam", SCREENING_STATUS]);

/**
 * A per-user budget on one-click POSTs, so an account cannot use Kite to fire requests at addresses it mails itself.
 * It shares the per-user outbound fetch limiter of the remote image proxy under its own key; a limiter error lets the
 * request through, as there.
 */
async function allowOneClick(env: CloudflareEnv, userId: string): Promise<boolean> {
	if (!env.REMOTE_IMAGE_RATE_LIMIT) return true;
	try {
		return (await env.REMOTE_IMAGE_RATE_LIMIT.limit({ key: `unsubscribe:${userId}` })).success;
	} catch (error) {
		console.warn("Unsubscribe rate limiter unavailable", error);
		return true;
	}
}

/**
 * Unsubscribes `user` from the list `messageId` came from with the RFC 8058 one-click POST. Everything is read again
 * from the stored message: the URL comes only from its own `List-Unsubscribe` header, never from the request, and
 * only when `List-Unsubscribe-Post` asks for one-click and a DKIM signature that passed covers both headers.
 */
export async function unsubscribeOneClick(
	env: CloudflareEnv,
	user: SessionUser,
	messageId: string,
): Promise<OneClickUnsubscribeResult> {
	const db = getDb(env);
	const [row] = await db
		.select({
			mailboxId: messages.mailboxId,
			userId: messages.userId,
			status: messages.status,
			direction: messages.direction,
			rawR2Key: messages.rawR2Key,
			spamSignals: messages.spamSignals,
		})
		.from(messages)
		.where(eq(messages.id, messageId))
		.limit(1);
	if (!row?.mailboxId || isHiddenDraft(row, user.id)) return { kind: "not_found" };
	const access = await getMailboxAccessLevel(db, user, row.mailboxId);
	if (!access?.canRead) return { kind: "not_found" };
	if (!access.canManage) return { kind: "forbidden" };

	const headers = await getMailingListHeadersFromRawR2Key(env, row.rawR2Key);
	const url = headers?.unsubscribeUrl ?? null;
	if (row.direction !== "inbound" || REFUSED_STATUSES.has(row.status)) return { kind: "unavailable", url: null };
	if (!headers || !canUseOneClick(headers, storedDkimPassed(row.spamSignals))) return { kind: "unavailable", url };
	if (!(await allowOneClick(env, user.id))) return { kind: "rate_limited" };

	const outcome = await postOneClickUnsubscribe(headers.oneClickUrl!, {
		resolveHost: env.RESOLVE_HOST,
		allowLoopback: isUnsubscribeLoopbackAllowed(env.UNSUBSCRIBE_ALLOW_LOOPBACK, process.env.NODE_ENV),
	});
	// The host only: the path and query of an unsubscribe link usually identify the recipient.
	const host = new URL(headers.oneClickUrl!).host;
	if (outcome.ok) {
		console.info("unsubscribe.one_click", { messageId, host, status: outcome.status });
		return { kind: "done" };
	}
	console.warn("unsubscribe.one_click_failed", { messageId, host, reason: outcome.reason, status: outcome.status });
	return { kind: "failed", url };
}
