import { DEFAULT_STORE_ID, getStorage } from "@/lib/storage";
import { endpointPolicyFor } from "@/lib/storage/config";
import { endpointHostname, isLoopbackHostname } from "@/lib/storage/endpoint-utils";
import { lookupObjectLocation } from "@/lib/storage/object-locations";
import type { KiteBucket, ObjectStore, StoreSigner } from "@/lib/storage/types";
import { markDriveObjectsCold } from "./storage-hooks";
import type { DriveRow } from "./types";

/** The store new Drive files are written to. */
export async function newDriveStore(env: CloudflareEnv): Promise<ObjectStore> {
	return (await getStorage(env)).storeFor("drive");
}

/** The bucket a file's bytes live in, from the store its row recorded; null for a store this install no longer has. */
export async function bucketOfItem(env: CloudflareEnv, item: Pick<DriveRow, "storeId">): Promise<KiteBucket | null> {
	return (await storeOfItem(env, item))?.bucket ?? null;
}

/** The store a file's row recorded; null for a store this install no longer has. */
export async function storeOfItem(env: CloudflareEnv, item: Pick<DriveRow, "storeId">): Promise<ObjectStore | null> {
	return (await getStorage(env)).store(item.storeId ?? DEFAULT_STORE_ID);
}

/**
 * Where `item`'s bytes actually are, when its own row's store does not have them: a restore can roll
 * `drive_items.store_id` back to a store a cold move already took the file off, since the row is normally the
 * only record of where a file lives. `object_locations` (`cold-move.ts`) survives that restore (merged, not
 * replaced), so this is the same fallback mail and backups get through the storage router, just reached from
 * inside the module instead. Repairs the row once the file is found, so later reads go straight to it.
 */
export async function recoverDriveStore(
	env: CloudflareEnv,
	item: Pick<DriveRow, "id" | "objectKey">,
): Promise<ObjectStore | null> {
	if (!item.objectKey) return null;
	const location = await lookupObjectLocation(env, item.objectKey);
	if (!location) return null;
	const store = (await getStorage(env)).store(location.storeId);
	const head = await store?.bucket.head(item.objectKey);
	if (!store || !head) return null;
	await markDriveObjectsCold(env, {
		ids: [item.id],
		storageClass: head.storageClass ?? null,
		storeId: location.storeId,
	});
	return store;
}

/** HTTP stores stay proxied: CSP upgrades their signed URLs, except loopback explicitly allowed in dev. */
export function browserSigner(env: CloudflareEnv, store: ObjectStore | null): StoreSigner | undefined {
	const signer = store?.signer;
	if (!signer) return undefined;
	const origin = new URL(signer.origin);
	if (origin.protocol === "https:") return signer;
	if (
		origin.protocol === "http:" &&
		endpointPolicyFor(env).allowInsecure &&
		isLoopbackHostname(endpointHostname(origin.host))
	)
		return signer;
	return undefined;
}

/** Multipart operations on a bucket, which the Node file bucket and R2 both have. */
export function multipartOf(bucket: KiteBucket) {
	if (!bucket.createMultipartUpload || !bucket.resumeMultipartUpload)
		throw new Error("This store does not support multipart uploads");
	return { create: bucket.createMultipartUpload.bind(bucket), resume: bucket.resumeMultipartUpload.bind(bucket) };
}
