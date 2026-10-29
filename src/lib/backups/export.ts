import { clearModuleStateCache } from "@/lib/modules/state";
import { clearStorageConfigCache } from "@/lib/storage/config";
import type { BackupTableGroupId, DatabaseBackupDocument, DatabaseBackupTable, DatabaseRecord } from "./types";
import {
	dropRetiredBackupTables,
	fillBookingEventSlug,
	indexLegacyMessageBodies,
	isDatabaseRecord,
	mergeLegacyMessageBody,
	RETIRED_BACKUP_TABLES,
} from "./utils";
import { BACKUP_TABLE_GROUPS, getSelectedBackupTables, isPartialBackupDocument } from "./table-groups";
import {
	BackupDocumentScanner,
	INVALID_BACKUP_MESSAGE,
	memoryBackupSource,
	parseJsonBytes,
	readSourcePages,
} from "./backup-reader-utils";
import { planRestoreDeletes, PRESERVED_ON_RESTORE, preservedRestoreTables, TableInsertBuilder } from "./restore-utils";
import { RestoreBatchWriter } from "./restore-writer";
import type {
	BackupSource,
	BackupTableRange,
	PreparedRestore,
	PreparedRestoreTable,
	RestoreStatement,
} from "./restore-types";

const BACKUP_TABLES: DatabaseBackupTable[] = [
	"users",
	"user_module_access",
	"domains",
	"mailboxes",
	"mailbox_access",
	"contacts",
	"folders",
	"api_keys",
	"messages",
	"message_attachments",
	"composer_sends",
	"ai_assisted_drafts",
	"shared_attachment_links",
	"outbound_jobs",
	"routing_rules",
	"webhooks",
	"webhook_deliveries",
	"sessions",
	"audit_logs",
	"backup_settings",
	"backups",
	"storage_stores",
	"storage_routes",
	"app_settings",
	"agent_providers",
	"module_settings",
	"email_templates",
	"booking_events",
	"calendar_events",
	"booking_appointments",
	"finance_subscriptions",
	"finance_charges",
	"drive_items",
	"drive_shares",
	"drive_links",
	"drive_settings",
	"drive_user_quotas",
	"auto_reply_deliveries",
	"spam_token_stats",
	"spam_reputation",
	"spam_feedback",
	"screener_settings",
	"screener_senders",
	"mailbox_aliases",
	"password_reset_tokens",
	"mfa_recovery_codes",
	"login_challenges",
	"mailbox_agent_settings",
	"user_ai_settings",
	"writing_style_profiles",
	"agent_conversations",
	"agent_chat_messages",
	"agent_jobs",
	"agent_draft_metadata",
	"agent_send_approvals",
	"agent_suggestions",
	"agent_actions",
	"agent_sender_policies",
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
const INTERNAL_TABLE_PATTERNS = ["sqlite_%", "_cf%", "messages_fts%", "calendar_events_fts%"];
/**
 * The search indexes are derived data: their triggers repopulate them as messages
 * and calendar events are restored, so they are neither exported nor part of the
 * coverage check.
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
	// The folders of a whole-account import (migration 0076): progress rows of an import_jobs row, transient with it.
	"import_job_folders",
	// Drive multipart parts of uploads in progress: the store's upload ids they
	// name do not survive a restore, so the parts would only point at nothing.
	"drive_upload_parts",
	// Storage migration jobs: transient work that points at the live stores, so replaying one into a
	// restored database would restart a copy between stores that may no longer match.
	"storage_migrations",
	// Usage statistics: the install id identifies this deployment, so a restore into another one must not clone it,
	// and the choice, the notice and its start day stay those of the deployment restored into.
	"telemetry_state",
	// AI summaries (migration 0072): derived from the messages and made again on demand, so a backup skips them.
	// A restore replaces the messages, whose triggers and cascades remove the old summaries with them.
	"ai_summaries",
	// Undo receipts of spam and phishing reports: transient (pruned after the 7-day undo window) and tied to
	// the toast or Activity entry that offered the undo, so a restored database starts without them.
	"spam_report_receipts",
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
async function readTablePage(
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
	excludedGroups: BackupTableGroupId[],
	existingTables: Set<string>,
): AsyncGenerator<string> {
	yield `{"format":"kite-database-backup","version":1,"createdAt":${JSON.stringify(new Date().toISOString())},"includedTables":${JSON.stringify(includedTables)},"excludedGroups":${JSON.stringify(excludedGroups)},"tables":{`;
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
	const knownGroups = new Set(BACKUP_TABLE_GROUPS.map((group) => group.id));
	const excluded = [...new Set(excludedGroups)].filter((group) => knownGroups.has(group));
	return backupDocumentChunks(db, includedTables, includedTables, excluded, databaseTables);
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
	return backupDocumentChunks(db, tables, [...BACKUP_TABLES], [], databaseTables);
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
 * Validates a backup against the current database without writing anything,
 * so an unusable file fails before any data is touched. The file is read in
 * ranged pages and only its outer structure is kept: every row is parsed and
 * checked, then dropped, and each table's byte range is recorded so
 * executeDatabaseRestore can read the rows again table by table.
 */
export async function prepareDatabaseRestore(
	db: D1Database,
	content: BackupSource | ArrayBuffer | Uint8Array,
): Promise<PreparedRestore> {
	const source = "read" in content ? content : memoryBackupSource(content);
	const { document, ranges } = await indexBackupDocument(source);
	if (isPartialBackupDocument(document))
		throw new Error(
			"This backup contains selected table groups only. Restore requires a backup that includes every table group.",
		);
	const databaseTables = await listApplicationTables(db);
	const preserved = await livePreservedTables(db, databaseTables);
	const tables: PreparedRestoreTable[] = [];
	for (const table of BACKUP_TABLES) {
		if (preserved.has(table)) continue;
		const range = ranges.get(table) ?? null;
		if (!databaseTables.has(table)) {
			if (range?.rows)
				throw new Error(`Apply pending database migrations before restoring ${table.replaceAll("_", " ")}.`);
			continue;
		}
		const columns = new Set(
			(await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>()).results.map((column) => column.name),
		);
		tables.push({ name: table, range, columns });
	}
	return {
		source,
		tables,
		legacyBodies: ranges.get("message_bodies") ?? null,
		rowCount: tables.reduce((total, table) => total + (table.range?.rows ?? 0), 0),
	};
}

/** Pass one over the file: the document without its rows, and where each table's rows are. */
async function indexBackupDocument(
	source: BackupSource,
): Promise<{ document: DatabaseBackupDocument; ranges: Map<string, BackupTableRange> }> {
	const scanner = new BackupDocumentScanner("document");
	const value: Record<string, unknown> = {};
	const tables: Record<string, unknown> = {};
	const ranges = new Map<string, BackupTableRange>();
	const checked = new Set<string>([...BACKUP_TABLES, "message_bodies"]);
	let rowError: string | null = null;
	const claim = (record: Record<string, unknown>, key: string, entry: unknown) => {
		if (key in record) throw new Error(INVALID_BACKUP_MESSAGE);
		record[key] = entry;
	};
	for await (const page of readSourcePages(source)) {
		for (const event of scanner.push(page)) {
			if (event.type === "member") claim(value, event.key, parseJsonBytes(event.raw));
			else if (event.type === "tableValue") claim(tables, event.name, parseJsonBytes(event.raw));
			else if (event.type === "tableStart") {
				claim(tables, event.name, []);
				ranges.set(event.name, { start: event.start, end: event.start, rows: 0 });
			} else if (event.type === "tableEnd") ranges.get(event.name)!.end = event.end;
			else {
				ranges.get(event.name)!.rows++;
				if (checked.has(event.name) && !rowError && !isDatabaseRecord(parseJsonBytes(event.raw)))
					rowError = `Backup contains an invalid ${event.name} record`;
			}
		}
	}
	scanner.finish();
	if ("tables" in value) throw new Error(INVALID_BACKUP_MESSAGE);
	if (ranges.size || Object.keys(tables).length) value.tables = tables;
	dropRetiredBackupTables(value);
	if (!isDatabaseBackupDocument(value)) throw new Error(INVALID_BACKUP_MESSAGE);
	if (rowError) throw new Error(rowError);
	return { document: value, ranges };
}

/** Reads one table's rows back by its range, a page at a time. */
async function* readTableRange(source: BackupSource, range: BackupTableRange): AsyncGenerator<DatabaseRecord> {
	const scanner = new BackupDocumentScanner("rows");
	for await (const page of readSourcePages(source, range.start, range.end)) {
		for (const event of scanner.push(page)) {
			if (event.type !== "row") continue;
			const row = parseJsonBytes(event.raw);
			if (!isDatabaseRecord(row)) throw new Error(INVALID_BACKUP_MESSAGE);
			yield row;
		}
	}
	scanner.finish();
}

/**
 * Pass two: empties the restored tables (children first) and inserts each
 * table's rows (parents first) as they are read, through `writer`, followed by
 * `finalStatements`. A restore that fits in one D1 batch is one transaction; a
 * larger one commits batch by batch, so the caller must hold a snapshot to roll
 * back to when this throws after `writer.committedBatches` became non-zero.
 */
export async function executeDatabaseRestore(
	db: D1Database,
	prepared: PreparedRestore,
	writer: RestoreBatchWriter = new RestoreBatchWriter(db),
	finalStatements: RestoreStatement[] = [],
): Promise<void> {
	try {
		const bodies = prepared.legacyBodies
			? indexLegacyMessageBodies(await collectRows(prepared.source, prepared.legacyBodies))
			: null;
		for (const statement of planRestoreDeletes(prepared.tables.map((table) => table.name))) await writer.add(statement);
		for (const table of prepared.tables) {
			if (!table.range?.rows) continue;
			const builder = new TableInsertBuilder(table.name, table.columns);
			for await (const row of readTableRange(prepared.source, table.range)) {
				if (table.name === "messages" && bodies) mergeLegacyMessageBody(row, bodies);
				if (table.name === "booking_events") fillBookingEventSlug(row);
				const statement = builder.add(row);
				if (statement) await writer.add(statement);
			}
			const last = builder.finish();
			if (last) await writer.add(last);
		}
		for (const statement of finalStatements) await writer.add(statement);
		await writer.flush();
	} finally {
		// The restore rewrites the module and storage tables behind the isolate's 30-second caches, even when it
		// fails part way.
		clearModuleStateCache();
		clearStorageConfigCache();
	}
}

async function collectRows(source: BackupSource, range: BackupTableRange): Promise<DatabaseRecord[]> {
	const rows: DatabaseRecord[] = [];
	for await (const row of readTableRange(source, range)) rows.push(row);
	return rows;
}

async function livePreservedTables(db: D1Database, databaseTables: Set<string>): Promise<Set<string>> {
	const counts: Record<string, number> = {};
	for (const table of PRESERVED_ON_RESTORE) {
		if (!databaseTables.has(table)) continue;
		const row = await db.prepare(`SELECT count(*) AS count FROM \`${table}\``).first<{ count: number }>();
		counts[table] = Number(row?.count ?? 0);
	}
	return preservedRestoreTables(counts);
}

export async function restoreDatabaseRecords(
	db: D1Database,
	content: BackupSource | ArrayBuffer | Uint8Array,
): Promise<void> {
	await executeDatabaseRestore(db, await prepareDatabaseRestore(db, content));
}

const BACKUP_FORMATS: string[] = ["kite-database-backup", "mailflare-database-backup"];

function isDatabaseBackupDocument(value: unknown): value is DatabaseBackupDocument {
	if (!value || typeof value !== "object") return false;
	const document = value as Partial<DatabaseBackupDocument>;
	if (!BACKUP_FORMATS.includes(document.format as string) || document.version !== 1 || !document.tables) return false;
	if (
		document.excludedGroups !== undefined &&
		(!Array.isArray(document.excludedGroups) || !document.excludedGroups.every((group) => typeof group === "string"))
	)
		return false;
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
