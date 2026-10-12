import { getMigrationStatus } from "./service";
import type { PendingMigrationStatus } from "./types";

/**
 * How long a failed queue message waits before its next attempt while the
 * schema is behind, and the usual delay when it is not. The longer wait gives
 * an admin time to apply the migration the message failed on.
 */
const MIGRATION_PENDING_RETRY_SECONDS = 60;
const DEFAULT_QUEUE_RETRY_SECONDS = 10;

/** The pending migration names, or null when the database could not be read at all. */
async function readPendingMigrations(db: D1Database): Promise<string[] | null> {
	try {
		const status = await getMigrationStatus(db);
		return status.pending;
	} catch (error) {
		console.error("Could not read the database migration status", error);
		return null;
	}
}

/**
 * The number of migrations the deployed code still has to apply, for the banner
 * every signed-in user sees. It only reads `sqlite_master` and `d1_migrations`,
 * so it answers while the schema is behind, and it never throws: an unreadable
 * database reads as "nothing pending" instead of breaking the page it is on.
 */
export async function getPendingMigrationStatus(
	db: D1Database,
	options: { includeNames?: boolean } = {},
): Promise<PendingMigrationStatus> {
	const pending = await readPendingMigrations(db);
	if (!pending?.length) return { pending: 0 };
	return options.includeNames ? { pending: pending.length, names: pending } : { pending: pending.length };
}

/**
 * How long a failed queue message waits before its next attempt. Inbound mail
 * that failed because a column is missing gets a longer wait, so an admin who
 * applies the migration in that window still keeps the message; when the
 * database cannot be read at all the usual delay stands.
 */
export async function queueRetryDelaySeconds(db: D1Database, fallback = DEFAULT_QUEUE_RETRY_SECONDS): Promise<number> {
	const pending = await readPendingMigrations(db);
	return pending?.length ? Math.max(fallback, MIGRATION_PENDING_RETRY_SECONDS) : fallback;
}
