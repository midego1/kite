import { notePrimaryWrite, primaryDatabase } from "@/lib/d1-session-utils";
import bundle from "./bundle.json";
import { applyPendingMigrationsFor, getMigrationStatusFor } from "./runner";
import type { BundledMigration, MigrationResult, MigrationStatus } from "./types";

const migrations = bundle.migrations as BundledMigration[];

// Both read `d1_migrations` and `sqlite_master` on the primary, never a read replica that has not caught up with a
// migration another admin (or `AUTO_APPLY_MIGRATIONS`) just applied: applying one twice would fail.
export function getMigrationStatus(db: D1Database): Promise<MigrationStatus> {
	return getMigrationStatusFor(primaryDatabase(db), migrations);
}

/**
 * The schema change is made on the raw binding, which the browser's session bookmark does not cover, so a request
 * that applied something sends the browser's next request to the primary (`notePrimaryWrite`).
 */
export async function applyPendingMigrations(db: D1Database): Promise<MigrationResult> {
	const result = await applyPendingMigrationsFor(primaryDatabase(db), migrations);
	if (result.applied.length) notePrimaryWrite(db);
	return result;
}
