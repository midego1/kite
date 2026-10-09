import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { applyPendingMigrationsFor, getMigrationStatusFor } from "@/lib/migrations/runner";
import type { BundledMigration } from "@/lib/migrations/types";
import { readMigrationBundle } from "../../scripts/migration-bundle-utils.mjs";
import type { SqliteDatabase } from "./sqlite-database";

export type ApplyMigrationsOptions = {
	/** Where to write a copy of the database file before migrating a non-empty database. */
	snapshotDir?: string;
};

/**
 * Apply the repository's migrations with the Worker's runner, splitter and
 * order, recording them in `d1_migrations` by file name exactly as Wrangler
 * does. A fresh database and an upgraded one therefore follow the same path
 * on both runtimes.
 */
export async function applyMigrations(
	database: SqliteDatabase,
	migrationsDir: string,
	options: ApplyMigrationsOptions = {},
): Promise<string[]> {
	const db = database as unknown as D1Database;
	const migrations = readMigrationBundle(migrationsDir) as BundledMigration[];
	const status = await getMigrationStatusFor(db, migrations);
	if (status.pending.length === 0) return [];

	if (options.snapshotDir && hasApplicationTables(database)) {
		mkdirSync(options.snapshotDir, { recursive: true });
		const target = join(options.snapshotDir, `pre-migration-${new Date().toISOString().replace(/[:.]/g, "-")}.sqlite`);
		await database.db.backup(target);
		console.log(`Saved a copy of the database to ${target} before migrating`);
	}

	return (await applyPendingMigrationsFor(db, migrations)).applied;
}

function hasApplicationTables(database: SqliteDatabase): boolean {
	return !!database.db
		.prepare(
			"SELECT 1 FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'd1_migrations' AND name NOT LIKE 'node_queue_%' LIMIT 1",
		)
		.get();
}
