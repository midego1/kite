/** `default` is the `BUCKET` binding (R2 on Workers, the file bucket on Node); configured stores arrive in phase 2. */
export type StoreId = "default" | `sto_${string}`;

/** Every object key belongs to one class, derived from its prefix. */
export type ObjectClass = "mail" | "drive" | "backups" | "system";

export type StoreCapabilities = {
	/** `createMultipartUpload` / `resumeMultipartUpload`. */
	multipart: boolean;
	/** Signed browser URLs (S3 stores; R2 only with S3 API keys). */
	presign: boolean;
	list: boolean;
	storageClasses: string[];
};

/** The R2 subset the app uses, so `env.BUCKET` keeps its R2Bucket type for every existing caller. */
export type KiteBucket = Pick<R2Bucket, "get" | "head" | "put" | "delete"> &
	Partial<Pick<R2Bucket, "createMultipartUpload" | "resumeMultipartUpload" | "list">>;

export type ObjectStore = {
	id: StoreId;
	bucket: KiteBucket;
	capabilities: StoreCapabilities;
};

export type Storage = {
	/** The store new objects of a class are written to. */
	storeFor(objectClass: ObjectClass): ObjectStore;
	/** The store a new object with this key is written to, by the class its prefix belongs to. */
	storeForKey(key: string): ObjectStore;
	/** A store by id, for objects that recorded where they live; null for an unknown id. */
	store(id: string): ObjectStore | null;
};
