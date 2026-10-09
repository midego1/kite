import { and, count, eq, gt, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { backups, outboundJobs, webhookDeliveries } from "@/db/schema";
import type { AlertPolicy, AlertSnapshot } from "./alerts-types";

const MINUTE = 60_000;

/** Select ids, counts and timestamps only; payload and error columns never leave the database. */
export async function collectAlertSnapshot(
	env: CloudflareEnv,
	now: Date,
	initializedAt: number,
	policy: AlertPolicy,
): Promise<AlertSnapshot> {
	const db = getDb(env);
	const at = now.getTime();
	const since = new Date(Math.floor(Math.max(initializedAt, at - policy.windowMinutes * MINUTE) / 1000) * 1000);
	const queuedBefore = new Date(at - policy.stuckQueuedMinutes * MINUTE);
	const sendingBefore = new Date(at - policy.stuckSendingMinutes * MINUTE);

	const [failedBackups, [failedSends], [stuck], [exhausted]] = await Promise.all([
		db
			.select({ id: backups.id, completedAt: backups.completedAt })
			.from(backups)
			.where(and(eq(backups.status, "failed"), gt(backups.completedAt, since))),
		db
			.select({ total: count() })
			.from(outboundJobs)
			.where(and(eq(outboundJobs.status, "failed"), gt(outboundJobs.updatedAt, since))),
		db
			.select({ total: count() })
			.from(outboundJobs)
			.where(
				or(
					and(
						eq(outboundJobs.status, "queued"),
						sql`coalesce(${outboundJobs.scheduledAt}, ${outboundJobs.createdAt}) < ${Math.floor(queuedBefore.getTime() / 1000)}`,
					),
					and(
						eq(outboundJobs.status, "sending"),
						sql`${outboundJobs.updatedAt} < ${Math.floor(sendingBefore.getTime() / 1000)}`,
					),
				),
			),
		db
			.select({ total: count(), lastAttemptAt: sql<number | null>`max(${webhookDeliveries.lastAttemptAt})` })
			.from(webhookDeliveries)
			.where(and(eq(webhookDeliveries.status, "exhausted"), gt(webhookDeliveries.lastAttemptAt, since))),
	]);

	return {
		failedBackups: failedBackups.map((row) => ({ id: row.id, completedAt: row.completedAt?.getTime() ?? 0 })),
		outboundFailed: failedSends?.total ?? 0,
		outboundStuck: stuck?.total ?? 0,
		webhookExhausted: exhausted?.total ?? 0,
		webhookLastAttemptAt: exhausted?.lastAttemptAt ? Number(exhausted.lastAttemptAt) * 1000 : null,
	};
}
