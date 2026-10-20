import type { KiteBucket, ObjectStore, Storage, StoreCapabilities } from "./types";

export const DEFAULT_STORE_ID = "default";

function capabilitiesOf(bucket: KiteBucket): StoreCapabilities {
	return {
		multipart: typeof bucket.createMultipartUpload === "function" && typeof bucket.resumeMultipartUpload === "function",
		// The binding cannot sign browser URLs; R2 direct mode needs S3 API keys (phase 2).
		presign: false,
		list: typeof bucket.list === "function",
		storageClasses: [],
	};
}

const cache = new WeakMap<object, Storage>();

/**
 * The object stores of this install. Until configured stores exist every class is held by the default store, the
 * `BUCKET` binding, so code that records a `store_id` keeps working unchanged when phase 2 adds more.
 */
export function getStorage(env: Pick<CloudflareEnv, "BUCKET">): Storage {
	const bucket = env.BUCKET as unknown as KiteBucket;
	const cached = cache.get(bucket);
	if (cached) return cached;
	const defaultStore: ObjectStore = { id: DEFAULT_STORE_ID, bucket, capabilities: capabilitiesOf(bucket) };
	const storage: Storage = {
		storeFor: () => defaultStore,
		store: (id: string) => (id === DEFAULT_STORE_ID ? defaultStore : null),
	};
	cache.set(bucket, storage);
	return storage;
}
