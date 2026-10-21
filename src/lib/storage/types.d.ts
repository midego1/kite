/** `default` is the `BUCKET` binding (R2 on Workers, the file bucket on Node); the others are `storage_stores` rows. */
export type StoreId = "default" | `sto_${string}`;

/** Every object key belongs to one class, derived from its prefix. */
export type ObjectClass = "mail" | "drive" | "backups" | "system";

/** The classes an admin can point at a store; `system` always stays on the default store. */
export type RoutableClass = Exclude<ObjectClass, "system">;

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

export type PresignGetOptions = {
	expiresIn: number;
	filename: string;
	disposition: "attachment" | "inline";
	contentType: string;
};

export type StoreSigner = {
	/** The exact origin browser requests go to, which the CSP lists in `connect-src`. */
	origin: string;
	presignGet(key: string, options: PresignGetOptions): Promise<string>;
	presignPut(key: string, options: { expiresIn: number; contentLength: number; contentType: string }): Promise<string>;
	presignUploadPart(
		key: string,
		uploadId: string,
		partNumber: number,
		options: { expiresIn: number; contentLength: number },
	): Promise<string>;
};

export type ObjectStore = {
	id: StoreId;
	bucket: KiteBucket;
	capabilities: StoreCapabilities;
	/** Present when `capabilities.presign`. */
	signer?: StoreSigner;
	/** Server-side copy within the store, when it has one. */
	copy?(sourceKey: string, targetKey: string): Promise<void>;
};

export type Storage = {
	/** The store new objects of a class are written to. */
	storeFor(objectClass: ObjectClass): ObjectStore;
	/** The store a new object with this key is written to, by the class its prefix belongs to. */
	storeForKey(key: string): ObjectStore;
	/** A store by id, for objects that recorded where they live; null for an unknown id. */
	store(id: string): ObjectStore | null;
};

export type S3Addressing = "virtual" | "path";

export type S3Provider = "aws" | "r2" | "b2" | "wasabi" | "hetzner" | "minio" | "other";

/** Where an S3-compatible bucket is and how to reach it, without credentials. */
export type S3Location = {
	/** Host, optionally with a port (`s3.eu-central-1.amazonaws.com`, `localhost:9000`); no scheme, no path. */
	endpoint: string;
	region: string;
	bucket: string;
	addressing: S3Addressing;
	scheme: "https" | "http";
};

export type S3Credentials = { accessKeyId: string; secretAccessKey: string };

export type S3StoreConfig = S3Location & S3Credentials;
