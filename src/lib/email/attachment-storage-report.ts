import { chunkArray } from "@/db/chunk-utils";
import { missingColumnFromError } from "@/lib/auth/user-lookup-utils";
import { ATTACHMENT_OBJECT_ROWS_SQL, rawBackedMessagesSql } from "./attachment-storage-utils";
import type {
	AttachmentStorageCounts,
	AttachmentObjectsVerification,
	AttachmentReclaimCounts,
	SharedObjectCounts,
} from "./attachment-storage-types";

/** Referenced object keys `verifyAttachmentObjects` looks up, newest first (`docs/specs/attachments-once.md` §5.5). */
const VERIFY_SAMPLE_KEYS = 200;
/** HEAD requests in flight at once. */
const VERIFY_CONCURRENCY = 20;

const number = (value: unknown) => Number(value ?? 0);

/**
 * How attachments are stored, for Admin. Object rows can share a key (a forward, a send from a draft), so `storedBytes`
 * counts each object once and `bytes` every row. Written against `r2_key` and `size`, which every schema has.
 */
export async function getAttachmentStorageCounts(env: CloudflareEnv): Promise<AttachmentStorageCounts> {
	const first = async <T>(sql: string) => (await env.DB.prepare(sql).first<T>()) ?? ({} as T);
	const object = `CASE WHEN ${ATTACHMENT_OBJECT_ROWS_SQL} THEN 1 END`;
	const [rows, stored] = await Promise.all([
		first<{ rows: number; bytes: number; objectRows: number; objectKeys: number; objectBytes: number }>(
			`SELECT count(*) AS rows, coalesce(sum(size), 0) AS bytes, count(${object}) AS objectRows, count(DISTINCT CASE WHEN ${ATTACHMENT_OBJECT_ROWS_SQL} THEN r2_key END) AS objectKeys, coalesce(sum(${object} * size), 0) AS objectBytes FROM message_attachments`,
		),
		first<{ bytes: number }>(
			`SELECT coalesce(sum(size), 0) AS bytes FROM (SELECT max(size) AS size FROM message_attachments WHERE ${ATTACHMENT_OBJECT_ROWS_SQL} GROUP BY r2_key)`,
		),
	]);
	return {
		objects: {
			rows: number(rows.objectRows),
			keys: number(rows.objectKeys),
			bytes: number(rows.objectBytes),
			storedBytes: number(stored.bytes),
		},
		raw: {
			rows: number(rows.rows) - number(rows.objectRows),
			bytes: number(rows.bytes) - number(rows.objectBytes),
		},
	};
}

/**
 * Objects more than one row names (a forward, a send from a draft): `keys` such objects and `rows` the rows beyond the
 * first that name them, which is how many copies materialize writes before a release older than sharing can run.
 */
export async function getSharedObjectCounts(env: CloudflareEnv): Promise<SharedObjectCounts> {
	const row = await env.DB.prepare(
		`SELECT count(*) AS keys, coalesce(sum(n - 1), 0) AS rows FROM (SELECT count(*) AS n FROM message_attachments WHERE ${ATTACHMENT_OBJECT_ROWS_SQL} GROUP BY r2_key HAVING count(*) > 1)`,
	).first<{ keys: number; rows: number }>();
	return { keys: number(row?.keys), rows: number(row?.rows) };
}

/**
 * The 'object' rows of received and imported mail (`isRawBackedMessage`), the only ones reclaim may turn into 'raw'
 * rows: `pending` it has not looked at yet, `unmatched` it looked at and left as they were. Null before migration
 * 0088 adds the storage columns.
 */
export async function getReclaimCounts(env: CloudflareEnv): Promise<AttachmentReclaimCounts | null> {
	try {
		const row = await env.DB.prepare(
			`SELECT count(CASE WHEN a.storage_checked_at IS NULL THEN 1 END) AS pendingRows, coalesce(sum(CASE WHEN a.storage_checked_at IS NULL THEN a.size END), 0) AS pendingBytes, count(a.storage_checked_at) AS unmatchedRows FROM message_attachments a JOIN messages m ON m.id = a.message_id WHERE ${ATTACHMENT_OBJECT_ROWS_SQL} AND a.storage = 'object' AND ${rawBackedMessagesSql("m")}`,
		).first<{ pendingRows: number; pendingBytes: number; unmatchedRows: number }>();
		return {
			pending: { rows: number(row?.pendingRows), bytes: number(row?.pendingBytes) },
			unmatched: { rows: number(row?.unmatchedRows) },
		};
	} catch (error) {
		if (missingColumnFromError(error)) return null;
		throw error;
	}
}

/**
 * Looks up the newest referenced object keys in storage (a HEAD each, never the content) and reports the ones that are
 * missing with the messages that name them: a delete that removed an object another row still used shows up here.
 */
export async function verifyAttachmentObjects(env: CloudflareEnv): Promise<AttachmentObjectsVerification> {
	const { results } = await env.DB.prepare(
		`SELECT r2_key AS key, group_concat(DISTINCT message_id) AS messageIds FROM message_attachments WHERE ${ATTACHMENT_OBJECT_ROWS_SQL} GROUP BY r2_key ORDER BY max(rowid) DESC LIMIT ?`,
	)
		.bind(VERIFY_SAMPLE_KEYS)
		.all<{ key: string; messageIds: string | null }>();
	const keys = results ?? [];
	const missing: AttachmentObjectsVerification["missing"] = [];
	for (const batch of chunkArray(keys, VERIFY_CONCURRENCY)) {
		const found = await Promise.all(batch.map((row) => env.BUCKET.head(row.key)));
		batch.forEach((row, index) => {
			if (!found[index]) missing.push({ key: row.key, messageIds: row.messageIds?.split(",") ?? [] });
		});
	}
	return { checked: keys.length, missing };
}
