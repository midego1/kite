import type { BackupTableGroupId, DatabaseBackupDocument, DatabaseBackupTable, DatabaseRecord } from "./types";
import { dropRetiredBackupTables, mergeLegacyMessageBodies, RETIRED_BACKUP_TABLES } from "./utils";
import { BACKUP_TABLE_GROUPS, getSelectedBackupTables } from "./table-groups";
import { createRestorePlan, planRestoreStatements } from "./restore-utils";
import type { RestoreBatchLimits, RestorePlan, RestoreTablePlan } from "./restore-types";

export const BACKUP_TABLES: DatabaseBackupTable[] = [
	"users",
	"domains",
	"mailboxes",
	"mailbox_access",
	"contacts",
	"folders",
	"api_keys",
	"messages",
	"message_attachments",
	"shared_attachment_links",
	"outbound_jobs",
	"routing_rules",
	"webhooks",
	"webhook_deliveries",
	"sessions",
	"audit_logs",
	"backup_settings",
	"backups",
	"app_settings",
	"email_templates",
	"calendar_events",
	"booking_events",
	"auto_reply_deliveries",
	"spam_token_stats",
	"spam_reputation",
	"spam_feedback",
	"mailbox_aliases",
	"password_reset_tokens",
	"mfa_recovery_codes",
	"login_challenges",
	"mailbox_agent_settings",
	"agent_conversations",
	"agent_chat_messages",
	"agent_jobs",
	"agent_draft_metadata",
	"agent_send_approvals",
	"mcp_key_mailboxes",
	"ai_usage",
];
/**
 * Tables every backup document must contain. Tables added to BACKUP_TABLES
 * after the format shipped are absent from older documents, so they stay
 * optional here and are filled in as empty on restore.
 */
const REQUIRED_BACKUP_TABLES: DatabaseBackupTable[] = [
	"users",
	"domains",
	"mailboxes",
	"mailbox_access",
	"contacts",
	"folders",
	"api_keys",
	"messages",
	"message_attachments",
	"outbound_jobs",
	"routing_rules",
	"webhooks",
	"webhook_deliveries",
	"sessions",
	"audit_logs",
	"backup_settings",
	"backups",
	"app_settings",
];

export function getBackupConfigurationStatus(_env?: CloudflareEnv) {
	return { configured: true, missing: [] };
}

/**
 * Tables D1 manages itself, which are intentionally absent from BACKUP_TABLES.
 */
const INTERNAL_TABLE_PATTERNS = ["sqlite_%", "_cf%", "messages_fts%"];
/**
 * The search index is derived data: its triggers repopulate it as messages are
 * restored, so it is neither exported nor part of the coverage check.
 */
const INTERNAL_TABLES = [
	"d1_migrations",
	// JMAP state counters, also derived: the jmap_messages_* triggers on
	// `messages` insert and bump a row per mailbox as messages are restored.
	// Exporting it would make restore fail, since the triggers recreate these
	// primary keys before the table's own rows would be inserted.
	"jmap_mailbox_revisions",
	// The self-hosted runtime's persisted job queue (server/runtime/queue.ts).
	// Jobs point at rows and blobs of the database they were queued against,
	// so they must not be replayed into a restored one.
	"node_queue_messages",
	// Background IMAP import jobs: transient work items that hold the source
	// server's password while running and point at queue messages, so restoring
	// them would resume imports against a database they no longer match.
	"import_jobs",
];

/**
 * Fails the backup when the database contains a table BACKUP_TABLES does not
 * list. Without this, a migration that adds a table silently produces backups
 * that omit it, and the omission only surfaces during a restore.
 */
export async function assertBackupTablesCoverDatabase(db: D1Database): Promise<Set<string>> {
	const databaseTables = await listApplicationTables(db);
	const covered = new Set<string>(BACKUP_TABLES);
	const unlisted = [...databaseTables].filter((name) => !covered.has(name));
	if (unlisted.length)
		throw new Error(
			`Backup aborted: ${unlisted.join(", ")} not listed in BACKUP_TABLES. Add new tables to src/lib/backups/export.ts and assign each to a group in table-groups.ts.`,
		);
	const assigned = BACKUP_TABLE_GROUPS.flatMap((group) => group.tables);
	const ungrouped = BACKUP_TABLES.filter((table) => assigned.filter((item) => item === table).length !== 1);
	const unknown = assigned.filter((table) => !covered.has(table));
	if (ungrouped.length || unknown.length)
		throw new Error(
			`Backup aborted: table groups are out of sync (${[...ungrouped, ...unknown].join(", ")}). Update src/lib/backups/table-groups.ts.`,
		);
	return databaseTables;
}

/** Rows per query while exporting; message rows carry full bodies, so keep pages small. */
const EXPORT_PAGE_SIZE = 100;
const EXPORT_ROWID_COLUMN = "__kite_rowid";

/** One page of a table in rowid order, starting after `afterRowid` (null for the first page). */
export async function readTablePage(
	db: D1Database,
	table: string,
	afterRowid: number | null,
	limit = EXPORT_PAGE_SIZE,
): Promise<{ rows: DatabaseRecord[]; lastRowid: number | null }> {
	const name = `\`${table.replaceAll("`", "``")}\``;
	const statement: D1PreparedStatement =
		afterRowid === null
			? db.prepare(`SELECT rowid AS ${EXPORT_ROWID_COLUMN}, * FROM ${name} ORDER BY rowid LIMIT ?`).bind(limit)
			: db
					.prepare(`SELECT rowid AS ${EXPORT_ROWID_COLUMN}, * FROM ${name} WHERE rowid > ? ORDER BY rowid LIMIT ?`)
					.bind(afterRowid, limit);
	const { results } = await statement.all<DatabaseRecord>();
	let lastRowid = afterRowid;
	const rows = results.map((row) => {
		const { [EXPORT_ROWID_COLUMN]: rowid, ...record } = row;
		lastRowid = rowid as number;
		return record;
	});
	return { rows, lastRowid };
}

/** Reads a table in rowid order one page at a time, so no query result holds the whole table. */
async function* readTableRows(db: D1Database, table: string): AsyncGenerator<DatabaseRecord> {
	let lastRowid: number | null = null;
	while (true) {
		const page = await readTablePage(db, table, lastRowid);
		yield* page.rows;
		lastRowid = page.lastRowid;
		if (page.rows.length < EXPORT_PAGE_SIZE) return;
	}
}

/**
 * Produces the backup document as JSON text in small pieces. The output is
 * byte-for-byte what JSON.stringify of a DatabaseBackupDocument would give.
 */
async function* backupDocumentChunks(
	db: D1Database,
	tables: string[],
	includedTables: string[],
	existingTables: Set<string>,
): AsyncGenerator<string> {
	yield `{"format":"kite-database-backup","version":1,"createdAt":${JSON.stringify(new Date().toISOString())},"includedTables":${JSON.stringify(includedTables)},"tables":{`;
	for (const [index, table] of tables.entries()) {
		yield `${index ? "," : ""}${JSON.stringify(table)}:[`;
		if (existingTables.has(table)) {
			let first = true;
			for await (const row of readTableRows(db, table)) {
				yield `${first ? "" : ","}${JSON.stringify(row)}`;
				first = false;
			}
		}
		yield "]";
	}
	yield "}}";
}

/** The configured backup's document, streamed; tables missing from an older schema come out empty. */
export async function streamDatabaseRecords(
	db: D1Database,
	excludedGroups: BackupTableGroupId[] = [],
): Promise<AsyncGenerator<string>> {
	const databaseTables = await assertBackupTablesCoverDatabase(db);
	const selected = getSelectedBackupTables(excludedGroups);
	const includedTables = BACKUP_TABLES.filter((table) => selected.has(table));
	if (!includedTables.length) throw new Error("Select at least one backup table group");
	return backupDocumentChunks(db, includedTables, includedTables, databaseTables);
}

/**
 * A full copy of every application table that exists right now, readable by
 * restore. Unlike streamDatabaseRecords it does not insist that the schema
 * matches this release, so it can be taken before migrations run; tables
 * BACKUP_TABLES does not list are kept for manual recovery and ignored by
 * restore.
 */
export async function streamDatabaseSnapshot(db: D1Database): Promise<AsyncGenerator<string>> {
	const databaseTables = await listApplicationTables(db);
	const tables = [
		...BACKUP_TABLES,
		...[...databaseTables].filter((name) => !BACKUP_TABLES.includes(name as DatabaseBackupTable)).sort(),
	];
	return backupDocumentChunks(db, tables, [...BACKUP_TABLES], databaseTables);
}

async function collectChunks(chunks: AsyncIterable<string>): Promise<Uint8Array> {
	const parts: string[] = [];
	for await (const chunk of chunks) parts.push(chunk);
	return new TextEncoder().encode(parts.join(""));
}

export async function exportDatabaseRecords(
	db: D1Database,
	excludedGroups: BackupTableGroupId[] = [],
): Promise<Uint8Array> {
	return collectChunks(await streamDatabaseRecords(db, excludedGroups));
}

export async function exportDatabaseSnapshot(db: D1Database): Promise<Uint8Array> {
	return collectChunks(await streamDatabaseSnapshot(db));
}

/** Every table that holds application data, i.e. everything but SQLite, D1 and derived tables. */
export async function listApplicationTables(db: D1Database): Promise<Set<string>> {
	const conditions = [
		...INTERNAL_TABLE_PATTERNS.map((pattern) => `name NOT LIKE '${pattern}'`),
		...[...INTERNAL_TABLES, ...RETIRED_BACKUP_TABLES].map((name) => `name <> '${name}'`),
	].join(" AND ");
	const result = await db
		.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND ${conditions}`)
		.all<{ name: string }>();
	return new Set(result.results.map((row) => row.name));
}

/**
 * Validates a backup document against the current database and turns it into
 * the statements that replace every backed-up table. Nothing is written, so
 * an unusable file fails here before any data is touched.
 */
export async function prepareDatabaseRestore(
	db: D1Database,
	content: ArrayBuffer,
	options: { limits?: RestoreBatchLimits } = {},
): Promise<RestorePlan> {
	const document = parseDatabaseBackup(content);
	if (
		document.includedTables &&
		!BACKUP_TABLE_GROUPS.every((group) => group.tables.some((table) => document.includedTables?.includes(table)))
	)
		throw new Error(
			"This backup contains selected table groups only. Restore requires a backup that includes every table group.",
		);
	mergeLegacyMessageBodies(document);
	fillMissingBackupTables(document);
	validateDatabaseBackup(document);
	const databaseTables = await listApplicationTables(db);
	const tables: RestoreTablePlan[] = [];
	for (const table of BACKUP_TABLES) {
		const rows = document.tables[table] ?? [];
		if (!databaseTables.has(table)) {
			if (rows.length)
				throw new Error(`Apply pending database migrations before restoring ${table.replaceAll("_", " ")}.`);
			continue;
		}
		const columns = new Set(
			(await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>()).results.map((column) => column.name),
		);
		tables.push({ name: table, rows, columns });
	}
	const { deletes, inserts } = planRestoreStatements(tables);
	return createRestorePlan(
		[...deletes, ...inserts],
		tables.reduce((total, table) => total + table.rows.length, 0),
		options.limits,
	);
}

/**
 * Runs a prepared restore. A plan that fits in one D1 batch is a single
 * transaction; a larger one commits batch by batch, so the caller must hold a
 * snapshot to roll back to if this throws.
 */
export async function executeDatabaseRestore(db: D1Database, plan: RestorePlan): Promise<void> {
	for (const chunk of plan.chunks) {
		await db.batch(chunk.map((statement) => db.prepare(statement.sql).bind(...statement.params)));
	}
}

export async function restoreDatabaseRecords(db: D1Database, content: ArrayBuffer): Promise<void> {
	await executeDatabaseRestore(db, await prepareDatabaseRestore(db, content));
}

function parseDatabaseBackup(content: ArrayBuffer): DatabaseBackupDocument {
	let value: unknown;
	try {
		value = JSON.parse(new TextDecoder().decode(content));
	} catch {
		throw new Error("The selected file is not a valid Kite backup");
	}
	dropRetiredBackupTables(value);
	if (!isDatabaseBackupDocument(value)) throw new Error("The selected file is not a valid Kite backup");
	return value;
}

const BACKUP_FORMATS: string[] = ["kite-database-backup", "mailflare-database-backup"];

function isDatabaseBackupDocument(value: unknown): value is DatabaseBackupDocument {
	if (!value || typeof value !== "object") return false;
	const document = value as Partial<DatabaseBackupDocument>;
	if (!BACKUP_FORMATS.includes(document.format as string) || document.version !== 1 || !document.tables) return false;
	if (document.includedTables) {
		if (
			!Array.isArray(document.includedTables) ||
			!document.includedTables.length ||
			new Set(document.includedTables).size !== document.includedTables.length
		)
			return false;
		if (
			!document.includedTables.every(
				(table) => BACKUP_TABLES.includes(table) && Array.isArray(document.tables?.[table]),
			)
		)
			return false;
	} else if (!REQUIRED_BACKUP_TABLES.every((table) => Array.isArray(document.tables?.[table]))) return false;
	return BACKUP_TABLES.every((table) => {
		const rows = document.tables?.[table];
		return rows === undefined || Array.isArray(rows);
	});
}

/** Backups written before a table joined BACKUP_TABLES simply omit it. */
function fillMissingBackupTables(document: DatabaseBackupDocument): void {
	for (const table of BACKUP_TABLES) {
		if (!document.tables[table]) document.tables[table] = [];
	}
	for (const row of document.tables.booking_events ?? []) {
		if (row.slug === undefined && typeof row.id === "string")
			row.slug = Array.from(new TextEncoder().encode(row.id))
				.map((byte) => byte.toString(16).padStart(2, "0"))
				.join("");
	}
}

function validateDatabaseBackup(document: DatabaseBackupDocument): void {
	for (const table of BACKUP_TABLES) {
		for (const row of document.tables[table] ?? []) {
			if (!row || typeof row !== "object" || Array.isArray(row)) {
				throw new Error(`Backup contains an invalid ${table} record`);
			}
		}
	}
}
