import bundle from "./bundle.json";
import { applyPendingMigrationsFor, getMigrationStatusFor } from "./runner";
import type { BundledMigration, MigrationResult, MigrationStatus } from "./types";

const migrations = bundle.migrations as BundledMigration[];

export function getMigrationStatus(db: D1Database): Promise<MigrationStatus> {
	return getMigrationStatusFor(db, migrations);
}

export function applyPendingMigrations(db: D1Database): Promise<MigrationResult> {
	return applyPendingMigrationsFor(db, migrations);
}
