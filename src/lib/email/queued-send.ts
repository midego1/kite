import { and, desc, eq, inArray, lte, notExists } from "drizzle-orm";
import { getDb } from "@/db";
import { messages, outboundJobs, users } from "@/db/schema";
import { claimAndDeliver, preparedDeliveryFromJob } from "@/lib/email/send";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { STUCK_SENDING_AFTER_MS } from "@/lib/messages/send-state-utils";

type Db = ReturnType<typeof getDb>;

/** Only the author can take back or hurry a queued send, and only while they still have send or manage access. */
async function authorCanSend(db: Db, userId: string, mailboxId: string): Promise<boolean> {
	const [author] = await db.select({ id: users.id, role: users.role }).from(users).where(eq(users.id, userId)).limit(1);
	const access = author ? await getMailboxAccessLevel(db, author, mailboxId) : null;
	return !!access && (access.canManage || access.canSendAs || access.canSendOnBehalf);
}

export type SendQueuedNowResult = { ok: true } | { ok: false; reason: "not_found" | "too_late" | "retrying" };

/**
 * Sends a message still waiting in the outbound queue (the undo window or a schedule) right away, for its
 * author. It takes the same conditional claim as the queue consumer, so the later queue message finds the job
 * claimed and does nothing: the message is never sent twice, and never both sent and undone. A job waiting for
 * the account server's retry (it carries that refusal as its error) keeps its own schedule, which also keeps its
 * attempt count: pressing Send now there would restart the count.
 */
export async function sendQueuedNow(
	env: CloudflareEnv,
	userId: string,
	messageId: string,
): Promise<SendQueuedNowResult> {
	const db = getDb(env);
	const [message] = await db
		.select({ id: messages.id, mailboxId: messages.mailboxId })
		.from(messages)
		.where(
			and(
				eq(messages.id, messageId),
				eq(messages.userId, userId),
				eq(messages.direction, "outbound"),
				eq(messages.status, "queued"),
			),
		)
		.limit(1);
	if (!message?.mailboxId) return { ok: false, reason: "not_found" };
	if (!(await authorCanSend(db, userId, message.mailboxId))) return { ok: false, reason: "not_found" };
	const [job] = await db
		.select({
			id: outboundJobs.id,
			status: outboundJobs.status,
			payload: outboundJobs.payload,
			error: outboundJobs.error,
		})
		.from(outboundJobs)
		.where(eq(outboundJobs.messageId, messageId))
		.orderBy(desc(outboundJobs.createdAt))
		.limit(1);
	if (!job || job.status !== "queued") return { ok: false, reason: "too_late" };
	if (job.error) return { ok: false, reason: "retrying" };
	const outcome = await claimAndDeliver(env, preparedDeliveryFromJob(job.payload, job.id, messageId, undefined));
	if (outcome === "sent") return { ok: true };
	return { ok: false, reason: outcome === "retrying" ? "retrying" : "too_late" };
}

export type CancelQueuedSendResult = { ok: true; draftId: string } | { ok: false; reason: "not_found" | "too_late" };

/**
 * Take back a message still waiting in the outbound queue and turn it into a draft again. A message whose
 * send failed is taken back the same way, to be edited and sent again, and so is one whose delivery has been
 * claimed for longer than `STUCK_SENDING_AFTER_MS` (nothing retries it; its job is marked failed). Only the
 * author can, and only while they still have send or manage access to the mailbox. The job and the message
 * change in one batch, so a cancelled job can never leave a queued message behind, or the other way round.
 */
export async function cancelQueuedSend(
	env: CloudflareEnv,
	userId: string,
	messageId: string,
): Promise<CancelQueuedSendResult> {
	const db = getDb(env);
	const [message] = await db
		.select({ id: messages.id, status: messages.status, mailboxId: messages.mailboxId })
		.from(messages)
		.where(
			and(
				eq(messages.id, messageId),
				eq(messages.userId, userId),
				eq(messages.direction, "outbound"),
				inArray(messages.status, ["queued", "failed"]),
			),
		)
		.limit(1);
	if (!message?.mailboxId) return { ok: false, reason: "not_found" };
	if (!(await authorCanSend(db, userId, message.mailboxId))) return { ok: false, reason: "not_found" };

	const stuckBefore = new Date(Date.now() - STUCK_SENDING_AFTER_MS);
	let takeBackJob = db
		.update(outboundJobs)
		.set({ status: "cancelled", updatedAt: new Date() })
		.where(and(eq(outboundJobs.messageId, messageId), eq(outboundJobs.status, "queued")));
	if (message.status === "queued") {
		const [job] = await db
			.select({ status: outboundJobs.status, updatedAt: outboundJobs.updatedAt })
			.from(outboundJobs)
			.where(eq(outboundJobs.messageId, messageId))
			.orderBy(desc(outboundJobs.createdAt))
			.limit(1);
		if (job?.status === "sending" && job.updatedAt <= stuckBefore) {
			takeBackJob = db
				.update(outboundJobs)
				.set({ status: "failed", error: "Moved to Drafts after the send stalled", updatedAt: new Date() })
				.where(
					and(
						eq(outboundJobs.messageId, messageId),
						eq(outboundJobs.status, "sending"),
						lte(outboundJobs.updatedAt, stuckBefore),
					),
				);
		} else if (job?.status !== "queued") {
			return { ok: false, reason: "too_late" };
		}
	}
	// The message follows only when no job of it is left waiting or being delivered, so whichever side lost the
	// race against delivery changes nothing.
	const toDraft = db
		.update(messages)
		.set({ status: "draft" })
		.where(
			and(
				eq(messages.id, messageId),
				eq(messages.status, message.status),
				notExists(
					db
						.select({ id: outboundJobs.id })
						.from(outboundJobs)
						.where(and(eq(outboundJobs.messageId, messageId), inArray(outboundJobs.status, ["queued", "sending"]))),
				),
			),
		);
	await db.batch([takeBackJob, toDraft]);

	const [after] = await db
		.select({ status: messages.status })
		.from(messages)
		.where(eq(messages.id, messageId))
		.limit(1);
	return after?.status === "draft" ? { ok: true, draftId: messageId } : { ok: false, reason: "too_late" };
}
