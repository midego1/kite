import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { messages } from "@/db/schema";
import type { SessionUser } from "@/lib/auth/types";
import { canUseOneClick, storedDkimPassed } from "@/lib/email/mailing-list-utils";
import { isUnsubscribeLoopbackAllowed, postOneClickUnsubscribe } from "@/lib/email/one-click-unsubscribe-utils";
import { completeOneClickAttempt, recordOneClickAttempt } from "@/lib/email/one-click-attempts";
import { getOneClickHeadersFromRawR2Key } from "@/lib/email/unsubscribe";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { isHiddenDraft } from "@/lib/messages/draft-privacy-utils";
import { SCREENING_STATUS } from "@/lib/screener/screener-utils";

type OneClickUnsubscribeResult =
	| { kind: "done" }
	| { kind: "not_found" }
	| { kind: "forbidden" }
	| { kind: "rate_limited" }
	/** The same user already asked for this message a few minutes ago; `url` is the link the reader can still open. */
	| { kind: "duplicate"; url: string | null }
	/** The message offers no verified one-click; `url` is the link the reader can still open. */
	| { kind: "unavailable"; url: string | null }
	| { kind: "failed"; url: string | null };

/**
 * Statuses whose mail is never unsubscribed from: confirming a spam address is live, mail not yet let in, and Trash
 * (where the reader shows no notice either).
 */
const REFUSED_STATUSES = new Set(["spam", "trash", SCREENING_STATUS]);

/** The attempt's row, or the refusal; a limiter that cannot record or count refuses (fails closed). */
async function admitAttempt(env: CloudflareEnv, input: { userId: string; mailboxId: string; messageId: string }) {
	try {
		return await recordOneClickAttempt(env, input);
	} catch (error) {
		console.warn("unsubscribe.one_click_limiter_failed", { messageId: input.messageId, error: String(error) });
		return { allowed: false as const, id: null, reason: "rate_limited" as const };
	}
}

/**
 * Unsubscribes `user` from the list `messageId` came from with the RFC 8058 one-click POST. Everything is read again
 * from the stored message: the URL comes only from its own `List-Unsubscribe` header, never from the request, and
 * only when `List-Unsubscribe-Post` asks for one-click and every DKIM signature, one of which passed, covers both
 * headers. One request per user and message every ten minutes (`recordOneClickAttempt`).
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

	const headers = await getOneClickHeadersFromRawR2Key(env, row.rawR2Key);
	const url = headers?.unsubscribeUrl ?? null;
	if (row.direction !== "inbound" || REFUSED_STATUSES.has(row.status)) return { kind: "unavailable", url: null };
	if (!headers || !canUseOneClick(headers, storedDkimPassed(row.spamSignals))) return { kind: "unavailable", url };
	const attempt = await admitAttempt(env, { userId: user.id, mailboxId: row.mailboxId, messageId });
	if (!attempt.allowed) return attempt.reason === "duplicate" ? { kind: "duplicate", url } : { kind: "rate_limited" };

	const outcome = await postOneClickUnsubscribe(headers.oneClickUrl!, {
		pinnedPost: env.PINNED_POST,
		allowLoopback: isUnsubscribeLoopbackAllowed(env.UNSUBSCRIBE_ALLOW_LOOPBACK, process.env.NODE_ENV),
	});
	await completeOneClickAttempt(
		env,
		attempt.id,
		outcome.ok ? { outcome: "done", status: outcome.status } : { outcome: outcome.reason, status: outcome.status },
	).catch(() => undefined);
	// The host only: the path and query of an unsubscribe link usually identify the recipient.
	const host = new URL(headers.oneClickUrl!).host;
	if (outcome.ok) {
		console.info("unsubscribe.one_click", { messageId, host, status: outcome.status });
		return { kind: "done" };
	}
	console.warn("unsubscribe.one_click_failed", { messageId, host, reason: outcome.reason, status: outcome.status });
	return { kind: "failed", url };
}
