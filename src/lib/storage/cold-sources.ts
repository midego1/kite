import { ATTACHMENT_OBJECT_ROWS_SQL } from "@/lib/email/attachment-storage-utils";
import { COLD_STORAGE_CLASS, R2_IA_TARGET, type ColdRule } from "./cold-utils";
import { beforeBodyColumn } from "./migration";
import { MAX_BATCH_OBJECTS, type MigrationSource } from "./migration-utils";
import { callStorageHook } from "./module-hooks";

export type Item = { id: string; key: string; size: number | null; createdAt: Date };
export type Page = { items: Item[]; exhausted: boolean };
type DbEnv = { DB: D1Database };

/** The `object_locations` exclusion for `rule.target`, bound to the one placeholder it adds. */
function exclusionClause(rule: ColdRule, keyExpr: string): { sql: string; param: string } {
	if (rule.target === R2_IA_TARGET)
		return {
			sql: `NOT EXISTS (SELECT 1 FROM object_locations ol WHERE ol.key = ${keyExpr} AND ol.storage_class = ?)`,
			param: COLD_STORAGE_CLASS,
		};
	return {
		sql: `NOT EXISTS (SELECT 1 FROM object_locations ol WHERE ol.key = ${keyExpr} AND ol.store_id = ?)`,
		param: rule.target,
	};
}

type Row = { id: string; key: string; size: number | null; created_at: number };

function rowsToItems(rows: Row[]): Item[] {
	return rows.map((row) => ({ id: row.id, key: row.key, size: row.size, createdAt: new Date(row.created_at * 1000) }));
}

/** One page of mail or backups candidates: old (and, where a size column exists, big) enough, not already moved. */
export async function coldPage(
	env: DbEnv,
	source: MigrationSource,
	rule: ColdRule,
	cutoff: number,
	after: string | null,
): Promise<Page> {
	const limit = MAX_BATCH_OBJECTS;
	const run = async (sql: string, binds: (string | number)[]) => {
		const results =
			(
				await env.DB.prepare(sql)
					.bind(...binds)
					.all<Row>()
			).results ?? [];
		return { items: rowsToItems(results), exhausted: results.length < limit };
	};
	if (source === "messages") {
		const exclusion = exclusionClause(rule, "messages.raw_r2_key");
		return run(
			`SELECT id, raw_r2_key AS key, NULL AS size, created_at FROM messages
			 WHERE raw_r2_key IS NOT NULL AND created_at <= ? AND id > ? AND ${exclusion.sql} ORDER BY id LIMIT ?`,
			[cutoff, after ?? "", exclusion.param, limit],
		);
	}
	if (source === "attachments") {
		const exclusion = exclusionClause(rule, "r2_key");
		return run(
			`SELECT r2_key AS id, r2_key AS key, max(size) AS size, min(created_at) AS created_at FROM message_attachments WHERE ${ATTACHMENT_OBJECT_ROWS_SQL}
			 AND created_at <= ? AND size >= ? AND r2_key > ? AND ${exclusion.sql} GROUP BY r2_key ORDER BY key LIMIT ?`,
			[cutoff, rule.minBytes, after ?? "", exclusion.param, limit],
		);
	}
	if (source === "bodies") {
		const exclusion = exclusionClause(rule, "'bodies/' || messages.id || '.html'");
		return beforeBodyColumn(
			() =>
				run(
					`SELECT id, 'bodies/' || id || '.html' AS key, body_size AS size, created_at FROM messages
					 WHERE html_body_key IS NOT NULL AND created_at <= ? AND coalesce(body_size, 0) >= ? AND id > ? AND ${exclusion.sql}
					 ORDER BY id LIMIT ?`,
					[cutoff, rule.minBytes, after ?? "", exclusion.param, limit],
				),
			{ items: [], exhausted: true },
		);
	}
	const exclusion = exclusionClause(rule, "r2_key");
	return run(
		`SELECT id, r2_key AS key, size, created_at FROM backups
		 WHERE r2_key IS NOT NULL AND status = 'completed' AND created_at <= ? AND size >= ? AND id > ? AND ${exclusion.sql}
		 ORDER BY id LIMIT ?`,
		[cutoff, rule.minBytes, after ?? "", exclusion.param, limit],
	);
}

type DriveCandidate = { id: string; key: string; size: number; storeId: string; createdAt: string };

/** One page of Drive candidates, through the Drive module's own hook (core never reads `drive_items`). */
export async function driveColdPage(
	rule: ColdRule,
	cutoffAt: number,
	after: string | null,
): Promise<{ items: (Item & { storeId: string })[]; exhausted: boolean }> {
	const page = await callStorageHook<{ objects: DriveCandidate[]; cursor: string | null }>("drive", "coldCandidates", {
		cutoff: new Date(cutoffAt * 1000).toISOString(),
		minBytes: rule.minBytes,
		target: rule.target,
		cursor: after,
		limit: MAX_BATCH_OBJECTS,
	});
	const objects = page?.objects ?? [];
	return {
		items: objects.map((object) => ({ ...object, createdAt: new Date(object.createdAt) })),
		exhausted: !page?.cursor,
	};
}
