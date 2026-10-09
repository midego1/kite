import type { BundledMigration, MigrationNameRow, MigrationResult, MigrationStatus } from "./types";

const MIGRATION_TABLE_SQL =
	"CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)";

async function getAppliedMigrationNames(db: D1Database): Promise<string[]> {
	const table = await db
		.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'd1_migrations'")
		.first<MigrationNameRow>();
	if (!table) return [];

	const result = await db.prepare("SELECT name FROM d1_migrations").all<MigrationNameRow>();
	return result.results.map((row) => row.name);
}

/**
 * Migration status and application over any D1-compatible database. The
 * Worker passes the generated bundle; the Node runtime reads the same files
 * through the same splitter and order (scripts/migration-bundle-utils.mjs).
 */
export async function getMigrationStatusFor(db: D1Database, migrations: BundledMigration[]): Promise<MigrationStatus> {
	const applied = new Set(await getAppliedMigrationNames(db));
	const committed = new Set(migrations.map((migration) => migration.name));
	const pending = migrations.filter((migration) => !applied.has(migration.name)).map((migration) => migration.name);
	const unknown = [...applied].filter((name) => !committed.has(name)).sort();

	return { ready: pending.length === 0 && unknown.length === 0, pending, unknown };
}

export async function applyPendingMigrationsFor(
	db: D1Database,
	migrations: BundledMigration[],
): Promise<MigrationResult> {
	const initial = await getMigrationStatusFor(db, migrations);
	if (initial.unknown.length > 0) {
		throw new Error("The database contains migrations that are not part of this Kite release.");
	}

	await db.prepare(MIGRATION_TABLE_SQL).run();
	const applied: string[] = [];

	for (const name of initial.pending) {
		const migration = migrations.find((candidate) => candidate.name === name);
		if (!migration) continue;

		try {
			await db.batch([
				db.prepare("INSERT INTO d1_migrations (name) VALUES (?)").bind(name),
				...migration.statements.map((statement) => db.prepare(statement)),
			]);
			applied.push(name);
		} catch (error) {
			const completed = await db
				.prepare("SELECT name FROM d1_migrations WHERE name = ?")
				.bind(name)
				.first<MigrationNameRow>();
			if (completed) continue;
			throw new Error(`Migration ${name} failed: ${error instanceof Error ? error.message : "Database error"}`);
		}
	}

	return { ...(await getMigrationStatusFor(db, migrations)), applied };
}
