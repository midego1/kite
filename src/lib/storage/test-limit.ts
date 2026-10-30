import { and, count, eq, gt } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLogs } from "@/db/schema";
import { newId } from "@/lib/ids";

/**
 * Test connection and the automatic R2 setup make requests on the admin's behalf (to an endpoint they type, or to
 * Cloudflare to create a token), so each admin gets a small budget per action.
 */
const ATTEMPTS_PER_WINDOW = 5;
const WINDOW_MS = 60_000;

export type StorageAttemptAction = "storage.store_tested" | "storage.auto_setup";

/**
 * Records one attempt as its audit row and answers whether it is within the limit. The row is written first and
 * the count read afterwards, including it, so requests racing in parallel can never all see room (the pattern of
 * `recordConnectionTest` for connected accounts). A refused attempt keeps its row, marked `outcome: "rate_limited"`,
 * and no other row is written for it. It needs no rate-limit binding and fails closed: when the row cannot be
 * written or counted, the caller refuses the attempt.
 */
export async function recordStorageAttempt(
	env: CloudflareEnv,
	userId: string,
	action: StorageAttemptAction,
	metadata: Record<string, unknown>,
): Promise<{ allowed: boolean; id: string }> {
	const db = getDb(env);
	const id = newId("aud");
	await db.insert(auditLogs).values({ id, actorUserId: userId, action, metadata: JSON.stringify(metadata) });
	const [row] = await db
		.select({ attempts: count() })
		.from(auditLogs)
		.where(
			and(
				eq(auditLogs.actorUserId, userId),
				eq(auditLogs.action, action),
				gt(auditLogs.createdAt, new Date(Date.now() - WINDOW_MS)),
			),
		);
	if ((row?.attempts ?? 0) <= ATTEMPTS_PER_WINDOW) return { allowed: true, id };
	await completeStorageAttempt(env, id, { ...metadata, outcome: "rate_limited" });
	return { allowed: false, id };
}

/** Writes the outcome onto the attempt's own row, so each attempt stays one audit row. Never a key. */
export async function completeStorageAttempt(
	env: CloudflareEnv,
	id: string,
	metadata: Record<string, unknown>,
): Promise<void> {
	await getDb(env)
		.update(auditLogs)
		.set({ metadata: JSON.stringify(metadata) })
		.where(eq(auditLogs.id, id));
}
