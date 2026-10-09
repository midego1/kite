import { FixedPartBuffer } from "./backup-writer-utils";

/** 8 MiB: above R2's 5 MiB minimum part size, small enough to keep Worker memory flat. */
export const BACKUP_PART_SIZE = 8 * 1024 * 1024;

/**
 * Writes a backup document to R2 while it is being produced, so a backup never
 * has to fit in Worker memory. Small documents are a single put; larger ones
 * become a multipart upload. Buckets without multipart support (the self-hosted
 * file bucket) get one put of the whole document.
 */
export async function writeBackupObject(
	bucket: R2Bucket,
	key: string,
	chunks: AsyncIterable<string>,
	options: { httpMetadata?: R2HTTPMetadata; customMetadata?: Record<string, string> },
	partSize = BACKUP_PART_SIZE,
): Promise<{ size: number }> {
	const encoder = new TextEncoder();
	const buffer = new FixedPartBuffer(partSize);
	const canStream = typeof (bucket as Partial<R2Bucket>).createMultipartUpload === "function";
	const parts: R2UploadedPart[] = [];
	let upload: R2MultipartUpload | null = null;
	let size = 0;
	try {
		for await (const chunk of chunks) {
			const bytes = encoder.encode(chunk);
			size += bytes.byteLength;
			buffer.push(bytes);
			if (!canStream) continue;
			for (let part = buffer.takePart(); part; part = buffer.takePart()) {
				upload ??= await bucket.createMultipartUpload(key, options);
				parts.push(await upload.uploadPart(parts.length + 1, part));
			}
		}
		const rest = buffer.takeRest();
		if (!upload) {
			await bucket.put(key, rest, options);
			return { size };
		}
		if (rest.byteLength) parts.push(await upload.uploadPart(parts.length + 1, rest));
		await upload.complete(parts);
		return { size };
	} catch (error) {
		await upload?.abort().catch(() => undefined);
		throw error;
	}
}
