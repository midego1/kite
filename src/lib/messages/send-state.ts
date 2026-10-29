import { desc, eq, inArray } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { queryInChunks } from "@/db/chunk-utils";
import { messages, outboundJobs } from "@/db/schema";
import { FAILED_SEND_STATUS, PENDING_SEND_STATUS, STUCK_SENDING_AFTER_MS, type SendState } from "./send-state-utils";

/**
 * The outbound state of the queued and failed messages among `rows`, from their newest outbound job: whether
 * Cancel send can still win (the job is unclaimed), whether delivery is under way and whether it has stalled. A
 * failed message's error is only told to its author.
 */
export async function loadSendStates(
	db: AppDatabase,
	rows: readonly { id: string; status: string; userId: string }[],
	viewerId: string,
	now = Date.now(),
): Promise<Map<string, SendState>> {
	const open = rows.filter((row) => row.status === PENDING_SEND_STATUS || row.status === FAILED_SEND_STATUS);
	const states = new Map<string, SendState>();
	if (open.length === 0) return states;
	const jobs = await queryInChunks(
		open.map((row) => row.id),
		(ids) =>
			db
				.select({
					messageId: outboundJobs.messageId,
					status: outboundJobs.status,
					updatedAt: outboundJobs.updatedAt,
					scheduledAt: outboundJobs.scheduledAt,
					error: outboundJobs.error,
				})
				.from(outboundJobs)
				.where(inArray(outboundJobs.messageId, ids))
				.orderBy(desc(outboundJobs.createdAt)),
	);
	const newest = new Map<string, (typeof jobs)[number]>();
	for (const job of jobs) if (job.messageId && !newest.has(job.messageId)) newest.set(job.messageId, job);
	for (const row of open) {
		const job = newest.get(row.id);
		const inFlight = row.status === PENDING_SEND_STATUS && job?.status === "sending";
		const sendingFor = inFlight && job?.updatedAt ? now - job.updatedAt.getTime() : 0;
		states.set(row.id, {
			status: row.status === PENDING_SEND_STATUS ? PENDING_SEND_STATUS : FAILED_SEND_STATUS,
			scheduledAt: job?.scheduledAt ? job.scheduledAt.toISOString() : null,
			cancellable: row.status === PENDING_SEND_STATUS && job?.status === "queued",
			inFlight,
			...(sendingFor >= STUCK_SENDING_AFTER_MS ? { stuckMinutes: Math.floor(sendingFor / 60_000) } : {}),
			own: row.userId === viewerId,
			...(row.status === FAILED_SEND_STATUS && row.userId === viewerId ? { error: job?.error ?? null } : {}),
		});
	}
	return states;
}

/** The list condition for a `status` filter naming one status or, for the Sent folder, several. */
export function statusFilterCondition(statuses: readonly string[]): SQL {
	return statuses.length === 1 ? eq(messages.status, statuses[0]) : inArray(messages.status, [...statuses]);
}
