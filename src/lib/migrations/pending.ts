import { getMigrationStatus } from "./service";
import type { MigrationApplier, PendingMigrationStatus } from "./types";

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
 * The primary admin, the only account that can apply migrations. Plain SQL over
 * columns as old as the users table, so it answers while the schema is behind;
 * null when it cannot be read.
 */
async function readMigrationApplier(db: D1Database): Promise<MigrationApplier | null> {
	try {
		return await db
			.prepare(
				"SELECT name, email FROM users WHERE role = 'admin' AND is_primary_admin = 1 AND disabled = 0 ORDER BY created_at LIMIT 1",
			)
			.first<MigrationApplier>();
	} catch (error) {
		console.error("Could not read the primary admin for the migration status", error);
		return null;
	}
}

/**
 * The number of migrations the deployed code still has to apply, for the banner
 * every signed-in user sees. It only reads `sqlite_master` and `d1_migrations`,
 * so it answers while the schema is behind, and it never throws: an unreadable
 * database reads as "nothing pending" instead of breaking the page it is on.
 * `includeApplier` adds who can apply them, for admins who cannot.
 */
export async function getPendingMigrationStatus(
	db: D1Database,
	options: { includeNames?: boolean; includeApplier?: boolean } = {},
): Promise<PendingMigrationStatus> {
	const pending = await readPendingMigrations(db);
	if (!pending?.length) return { pending: 0 };
	const status: PendingMigrationStatus = { pending: pending.length };
	if (options.includeNames) status.names = pending;
	if (options.includeApplier) {
		const applier = await readMigrationApplier(db);
		if (applier) status.appliedBy = { name: applier.name, email: applier.email };
	}
	return status;
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
