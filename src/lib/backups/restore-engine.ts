import { clearModuleStateCache } from "@/lib/modules/state";
import { clearStorageConfigCache } from "@/lib/storage/config";
import type { DatabaseRecord } from "./types";
import { fillBookingEventSlug, isDatabaseRecord } from "./utils";
import { restoredBackupRow } from "./external-accounts-utils";
import { BackupDocumentScanner, INVALID_BACKUP_MESSAGE, parseJsonBytes, readSourcePages } from "./backup-reader-utils";
import {
	legacyBodyStatement,
	planRestoreDeletes,
	probeStatement,
	restoreProbe,
	restoreSegments,
	TableInsertBuilder,
} from "./restore-utils";
import { RestoreBatchWriter } from "./restore-writer";
import type {
	BackupSource,
	BackupTableRange,
	PreparedRestore,
	PreparedRestoreTable,
	RestoreCursor,
	RestorePosition,
	RestoreRunOptions,
	RestoreSegment,
} from "./restore-types";

export const RESTORE_START: RestorePosition = { segment: 0, offset: null, rows: 0 };

/** A backup row as it is inserted: older rows get the fields later releases added, credentials are dropped. */
export function restoredRow(table: string, row: DatabaseRecord): DatabaseRecord {
	if (table === "booking_events") fillBookingEventSlug(row);
	return restoredBackupRow(table, row);
}

type RangeRow = { value: unknown; end: number };

/**
 * Reads one table's rows back by its range, a page at a time, from its start or (with `after`) right after the
 * row that ends at that byte.
 */
async function* readRange(
	source: BackupSource,
	range: BackupTableRange,
	after: number | null,
): AsyncGenerator<RangeRow> {
	const start = after ?? range.start;
	const scanner = new BackupDocumentScanner("rows", { baseOffset: start, resumeAfterRow: after !== null });
	for await (const page of readSourcePages(source, start, range.end)) {
		for (const event of scanner.push(page)) {
			if (event.type === "row") yield { value: parseJsonBytes(event.raw), end: event.end };
		}
	}
	scanner.finish();
}

/** Stops the restore at a batch boundary once the deadline passed; returns where to continue. */
class Deadline extends Error {}

type SegmentContext = {
	writer: RestoreBatchWriter;
	source: BackupSource;
	index: number;
	from: RestorePosition;
	/** The furthest position whose statements have all been handed to the writer. */
	reached: RestorePosition;
	checkDeadline: () => void;
};

async function writeRows(table: PreparedRestoreTable, context: SegmentContext): Promise<void> {
	const { writer, index, from } = context;
	if (!table.range?.rows) return;
	const columns = new Set(table.columns);
	const builder = new TableInsertBuilder<RestorePosition>(table.name, columns);
	const emit = async (built: ReturnType<typeof builder.finish>) => {
		if (!built) return;
		await writer.add(built.statement, built.meta, restoreProbe(table.name, built.last, table.primaryKey, columns));
		context.reached = built.meta!;
		context.checkDeadline();
	};
	let rows = from.segment === index ? from.rows : 0;
	for await (const row of readRange(context.source, table.range, from.segment === index ? from.offset : null)) {
		if (!isDatabaseRecord(row.value)) throw new Error(INVALID_BACKUP_MESSAGE);
		rows++;
		await emit(builder.add(restoredRow(table.name, row.value), { segment: index, offset: row.end, rows }));
	}
	if (rows !== table.range.rows) throw new Error("The backup file changed or could not be read while restoring");
	const last = builder.finish();
	if (last) last.meta = { segment: index + 1, offset: null, rows: 0 };
	await emit(last);
}

/** The legacy bodies, as updates that may run twice, so they need no probe. */
async function writeBodies(segment: Extract<RestoreSegment, { kind: "bodies" }>, context: SegmentContext) {
	const { writer, index, from } = context;
	const columns = new Set(segment.columns);
	let rows = from.segment === index ? from.rows : 0;
	for await (const row of readRange(context.source, segment.range, from.segment === index ? from.offset : null)) {
		rows++;
		const statement = legacyBodyStatement(row.value, columns);
		if (!statement) continue;
		context.reached = { segment: index, offset: row.end, rows };
		await writer.add(statement, context.reached);
		context.checkDeadline();
	}
}

/**
 * Pass two: empties the restored tables (children first) and inserts each table's rows (parents first) as they
 * are read, through `writer`, with the kept backup rows right after the `backups` table. A restore that fits in one
 * D1 batch is one transaction; a larger one commits batch by batch, so the caller must hold a snapshot to roll
 * back to when this throws after `writer.committedBatches` became non-zero.
 *
 * Starts at `from` and returns null when the restore is complete, or, once `deadline` passed, the position to
 * continue from after the last committed batch. Each call gets at least one statement or segment further, so a
 * restore continued call after call always ends.
 */
export async function executeDatabaseRestore(
	db: D1Database,
	prepared: PreparedRestore,
	{ writer = new RestoreBatchWriter(db), keep = [], from = RESTORE_START, deadline }: RestoreRunOptions = {},
): Promise<RestorePosition | null> {
	const segments = restoreSegments(prepared);
	const context: SegmentContext = {
		writer,
		source: prepared.source,
		index: from.segment,
		from,
		reached: from,
		checkDeadline: () => {
			if (deadline !== undefined && Date.now() >= deadline) throw new Deadline();
		},
	};
	try {
		for (; context.index < segments.length; context.index++) {
			const segment = segments[context.index]!;
			const next = { segment: context.index + 1, offset: null, rows: 0 };
			if (segment.kind === "deletes") {
				for (const statement of planRestoreDeletes(prepared.tables.map((table) => table.name)))
					await writer.add(statement, next);
			} else if (segment.kind === "kept") {
				for (const statement of keep) await writer.add(statement, next);
			} else if (segment.kind === "rows") await writeRows(segment.table, context);
			else await writeBodies(segment, context);
			context.reached = next;
			context.checkDeadline();
		}
		await writer.flush();
		return null;
	} catch (error) {
		if (!(error instanceof Deadline)) throw error;
		await writer.flush();
		return context.reached;
	} finally {
		// The restore rewrites the module and storage tables behind the isolate's 30-second caches, even when it
		// fails part way.
		clearModuleStateCache();
		clearStorageConfigCache();
	}
}

/** Where an interrupted restore continues: after its pending batch if that batch's probe row is there. */
export async function resolveRestoreCursor(db: D1Database, cursor: RestoreCursor): Promise<RestorePosition> {
	const { pending } = cursor;
	if (!pending) return cursor.at;
	if (!pending.probe) return cursor.at;
	const probe = probeStatement(pending.probe);
	const found = await db
		.prepare(probe.sql)
		.bind(...probe.params)
		.first<{ found: number }>();
	return found ? pending.to : cursor.at;
}
