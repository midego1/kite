import { chunkArray } from "@/db/chunk-utils";
import { ATTACHMENT_OBJECT_ROWS_SQL } from "./attachment-storage-utils";
import type { AttachmentStorageCounts, AttachmentObjectsVerification } from "./attachment-storage-types";

/** Referenced object keys `verifyAttachmentObjects` looks up, newest first (`docs/specs/attachments-once.md` §5.5). */
export const VERIFY_SAMPLE_KEYS = 200;
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
