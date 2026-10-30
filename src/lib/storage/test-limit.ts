import { and, count, eq, gt } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLogs } from "@/db/schema";
import { createAuditLog } from "@/lib/mailboxes/audit";

/** Test connection makes requests to an endpoint the admin types, so each admin gets a small budget. */
const STORAGE_TESTS_PER_WINDOW = 5;
const TEST_WINDOW_MS = 60_000;

/**
 * Records one Test connection attempt as its `storage.store_tested` audit row and answers whether it is within the
 * limit. The row is written first and the count read afterwards, including it, so requests racing in parallel can
 * never all see room (the pattern of `recordConnectionTest` for connected accounts). It needs no rate-limit binding
 * and fails closed: when the row cannot be written or counted, the caller refuses the test.
 */
export async function recordStorageTest(
	env: CloudflareEnv,
	userId: string,
	metadata: Record<string, unknown>,
): Promise<boolean> {
	await createAuditLog(env, { actorUserId: userId, action: "storage.store_tested", metadata });
	const [row] = await getDb(env)
		.select({ tests: count() })
		.from(auditLogs)
		.where(
			and(
				eq(auditLogs.actorUserId, userId),
				eq(auditLogs.action, "storage.store_tested"),
				gt(auditLogs.createdAt, new Date(Date.now() - TEST_WINDOW_MS)),
			),
		);
	return (row?.tests ?? 0) <= STORAGE_TESTS_PER_WINDOW;
}
