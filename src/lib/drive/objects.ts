import { DEFAULT_STORE_ID, getStorage } from "@/lib/storage";
import type { KiteBucket, ObjectStore } from "@/lib/storage/types";
import type { DriveRow } from "./types";

/** The store new Drive files are written to. */
export function newDriveStore(env: CloudflareEnv): ObjectStore {
	return getStorage(env).storeFor("drive");
}

/** The bucket a file's bytes live in, from the store its row recorded; null for a store this install no longer has. */
export function bucketOfItem(env: CloudflareEnv, item: Pick<DriveRow, "storeId">): KiteBucket | null {
	return getStorage(env).store(item.storeId ?? DEFAULT_STORE_ID)?.bucket ?? null;
}

/** Multipart operations on a bucket, which the Node file bucket and R2 both have. */
export function multipartOf(bucket: KiteBucket) {
	if (!bucket.createMultipartUpload || !bucket.resumeMultipartUpload)
		throw new Error("This store does not support multipart uploads");
	return { create: bucket.createMultipartUpload.bind(bucket), resume: bucket.resumeMultipartUpload.bind(bucket) };
}
