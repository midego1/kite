import { primaryDatabase } from "@/lib/d1-session-utils";
import bundle from "./bundle.json";
import { applyPendingMigrationsFor, getMigrationStatusFor } from "./runner";
import type { BundledMigration, MigrationResult, MigrationStatus } from "./types";

const migrations = bundle.migrations as BundledMigration[];

// Both read `d1_migrations` and `sqlite_master` on the primary, never a read replica that has not caught up with a
// migration another admin (or `AUTO_APPLY_MIGRATIONS`) just applied: applying one twice would fail.
export function getMigrationStatus(db: D1Database): Promise<MigrationStatus> {
	return getMigrationStatusFor(primaryDatabase(db), migrations);
}

export function applyPendingMigrations(db: D1Database): Promise<MigrationResult> {
	return applyPendingMigrationsFor(primaryDatabase(db), migrations);
}
