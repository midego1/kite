import type { BackupSource } from "./restore-types";

/**
 * A backup object read by byte range, so restoring never loads the whole file:
 * R2, S3 stores behind the storage router and the self-hosted file bucket all
 * serve ranged gets.
 */
export async function bucketBackupSource(bucket: R2Bucket, key: string, pageSize?: number): Promise<BackupSource> {
	const head = await bucket.head(key);
	if (!head) throw new Error("The backup file could not be found in storage");
	return {
		size: head.size,
		pageSize,
		async read(offset, length) {
			const object = await bucket.get(key, { range: { offset, length } });
			if (!object || !("arrayBuffer" in object)) throw new Error("The backup file could not be read from storage");
			return new Uint8Array(await object.arrayBuffer());
		},
	};
}
