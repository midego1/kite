/** A request connected accounts refuse, answered with its status (and a code) instead of failing the call. */
export class ExternalAccountRefusal extends Error {
	constructor(
		readonly status: number,
		message: string,
		readonly code?: string,
	) {
		super(message);
		this.name = "ExternalAccountRefusal";
	}
}

export const MIGRATION_PENDING_CODE = "MIGRATION_PENDING";

export const migrationPending = () =>
	new ExternalAccountRefusal(
		409,
		"Apply the pending database update to use connected accounts",
		MIGRATION_PENDING_CODE,
	);

const TABLES = ["external_accounts", "external_account_folders"];

/** Migrations only add tables, so once they exist the check is skipped for the rest of the isolate's life. */
const readyDatabases = new WeakSet<object>();

/**
 * Whether migration 0079 has been applied. It reads only `sqlite_master` with the names bound, so the statement never
 * names a table that may be missing.
 */
export async function externalAccountTablesReady(env: Pick<CloudflareEnv, "DB">): Promise<boolean> {
	if (readyDatabases.has(env.DB)) return true;
	const row = await env.DB.prepare(
		`SELECT count(*) AS present FROM sqlite_master WHERE type = 'table' AND name IN (${TABLES.map(() => "?").join(", ")})`,
	)
		.bind(...TABLES)
		.first<{ present: number }>();
	const ready = Number(row?.present ?? 0) === TABLES.length;
	if (ready) readyDatabases.add(env.DB);
	return ready;
}
