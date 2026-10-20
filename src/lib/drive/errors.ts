import { isNoSuchTableError } from "@/lib/modules/state-utils";
import type { DriveAnswer } from "./types";

const MIGRATION_PENDING_ERROR = "Apply the pending database update first";
const MIGRATION_PENDING_CODE = "MIGRATION_PENDING";

const DRIVE_TABLES = [
	"drive_items",
	"drive_shares",
	"drive_links",
	"drive_upload_parts",
	"drive_settings",
	"drive_user_quotas",
];

/** A request Drive refuses, answered with its status instead of failing the call. */
export class DriveRefusal extends Error {
	constructor(
		readonly status: number,
		message: string,
		readonly code?: string,
	) {
		super(message);
	}
}

export const ok = (body: Record<string, unknown>, status = 200): DriveAnswer => ({ status, body });
export const fail = (status: number, error: string, code?: string): DriveAnswer => ({
	status,
	body: code ? { error, code } : { error },
});
export const notFound = (): DriveAnswer => fail(404, "Not found");
const pending = (): DriveAnswer => fail(409, MIGRATION_PENDING_ERROR, MIGRATION_PENDING_CODE);

/**
 * Whether migration 0064 has been applied. It reads only `sqlite_master`, and the names are bound, so the
 * statement never names a table that may be missing.
 */
export async function driveTablesReady(env: CloudflareEnv): Promise<boolean> {
	if (readyDatabases.has(env.DB)) return true;
	const row = await env.DB.prepare(
		`SELECT count(*) AS present FROM sqlite_master WHERE type = 'table' AND name IN (${DRIVE_TABLES.map(() => "?").join(", ")})`,
	)
		.bind(...DRIVE_TABLES)
		.first<{ present: number }>();
	const ready = Number(row?.present ?? 0) === DRIVE_TABLES.length;
	if (ready) readyDatabases.add(env.DB);
	return ready;
}

/** Migrations only add tables, so once they exist the check is skipped for the rest of the isolate's life. */
const readyDatabases = new WeakSet<object>();

/**
 * Runs a Drive operation and turns refusals into answers. Before migration 0064 a mutation answers
 * 409 `MIGRATION_PENDING` and a read answers `whenPending` instead of failing on a missing table.
 */
export async function answerDrive(
	env: CloudflareEnv,
	run: () => Promise<DriveAnswer>,
	whenPending?: Record<string, unknown>,
): Promise<DriveAnswer> {
	const pendingAnswer = () => (whenPending ? ok({ ...whenPending, migrationPending: true }) : pending());
	if (!(await driveTablesReady(env))) return pendingAnswer();
	try {
		return await run();
	} catch (error) {
		if (error instanceof DriveRefusal) return fail(error.status, error.message, error.code);
		if (isNoSuchTableError(error)) return pendingAnswer();
		throw error;
	}
}
