import { createLogger } from "@/lib/logger.mjs";
import {
	activeStoreId,
	DEFAULT_STORE_ID,
	deleteTargets,
	readChain,
	type StorageConfig,
	type StoreRecord,
} from "./config-utils";
import { loadStorageConfig, openStoreCredentials, type StorageEnv } from "./config";
import { objectClassOf } from "./object-classes-utils";
import { S3Bucket } from "./s3-bucket";
import type { KiteBucket, ObjectClass, ObjectStore, Storage, StoreCapabilities } from "./types";

export { DEFAULT_STORE_ID } from "./config-utils";

const log = createLogger("storage");

/** Shared by every copy of this module (the Node build loads it twice), so a wrapped env is always recognised. */
export const RAW_ENV = Symbol.for("kite.storage.raw-env");

export type Proxied = { [RAW_ENV]?: CloudflareEnv };

/**
 * The env underneath `withStorage`, whose `BUCKET` is the binding itself.
 * @public Exercised by the unit tests.
 */
export function rawEnvOf<T extends object>(env: T): T {
	return ((env as Proxied)[RAW_ENV] as T | undefined) ?? env;
}

export type StoragePlatformEnv = StorageEnv & Pick<CloudflareEnv, "BUCKET">;

function bindingCapabilities(bucket: KiteBucket): StoreCapabilities {
	return {
		multipart: typeof bucket.createMultipartUpload === "function" && typeof bucket.resumeMultipartUpload === "function",
		presign: false,
		list: typeof bucket.list === "function",
		storageClasses: [],
	};
}

const S3_CAPABILITIES: StoreCapabilities = { multipart: true, presign: true, list: true, storageClasses: [] };

function s3BucketFor(env: StorageEnv, record: StoreRecord): S3Bucket {
	return new S3Bucket(record.location, { credentials: () => openStoreCredentials(env, record) });
}

function s3Store(env: StorageEnv, record: StoreRecord): ObjectStore {
	const bucket = s3BucketFor(env, record);
	return {
		id: record.id as ObjectStore["id"],
		bucket: bucket as unknown as KiteBucket,
		capabilities: S3_CAPABILITIES,
		signer: bucket.signer,
		copy: (source, target) => bucket.copy(source, target),
	};
}

/** The default store; with R2 S3 API keys saved for the binding it can also sign browser URLs. */
function defaultStore(env: StorageEnv, binding: KiteBucket, config: StorageConfig): ObjectStore {
	const store: ObjectStore = { id: DEFAULT_STORE_ID, bucket: binding, capabilities: bindingCapabilities(binding) };
	const keys = [...config.stores.values()].find((record) => record.sameAsBinding && !record.blocked);
	if (!keys || env.KITE_RUNTIME === "node") return store;
	return {
		...store,
		capabilities: { ...store.capabilities, presign: true },
		signer: s3BucketFor(env, keys).signer,
	};
}

type Built = { config: StorageConfig; storage: Storage };
const built = new WeakMap<object, Built>();

function buildStorage(env: StoragePlatformEnv, config: StorageConfig): Storage {
	const binding = env.BUCKET as unknown as KiteBucket;
	const fallback = defaultStore(env, binding, config);
	const stores = new Map<string, ObjectStore>([[DEFAULT_STORE_ID, fallback]]);
	const store = (id: string): ObjectStore | null => {
		const cached = stores.get(id);
		if (cached) return cached;
		const record = config.stores.get(id);
		if (!record || record.blocked || record.sameAsBinding) return null;
		const opened = s3Store(env, record);
		stores.set(id, opened);
		return opened;
	};
	const storeFor = (objectClass: ObjectClass): ObjectStore => {
		const wanted = objectClass === "system" ? DEFAULT_STORE_ID : (config.routes.get(objectClass)?.storeId ?? null);
		const id = activeStoreId(config, objectClass);
		if (wanted && wanted !== id) log.warn("storage.route_unusable", { objectClass, storeId: wanted });
		return store(id) ?? fallback;
	};
	const storage: Storage = {
		storeFor,
		storeForKey: (key) => storeFor(objectClassOf(key)),
		store,
		readChain: (objectClass) => readChain(config, objectClass).map((id) => store(id) ?? fallback),
		deleteTargets: (objectClass) => deleteTargets(config, objectClass).map((id) => store(id) ?? fallback),
		connectOrigins: () => {
			const origins = new Set<string>();
			for (const id of [DEFAULT_STORE_ID, ...config.stores.keys()]) {
				const origin = store(id)?.signer?.origin;
				if (origin) origins.add(origin);
			}
			return [...origins];
		},
		config,
	};
	return storage;
}

/**
 * The object stores of this install, from the cached config: the `BUCKET` binding is `default`, and every saved
 * store a class may be routed to. Drive and the migration job address stores explicitly through this; everything
 * else keeps using `env.BUCKET`, which `withStorage` routes.
 */
export async function getStorage(env: StoragePlatformEnv): Promise<Storage> {
	const raw = rawEnvOf(env);
	const config = await loadStorageConfig(raw);
	const key = raw.BUCKET as unknown as object;
	const cached = built.get(key);
	if (cached?.config === config) return cached.storage;
	const storage = buildStorage(raw, config);
	built.set(key, { config, storage });
	return storage;
}

/** The store origins every document's CSP lists in `connect-src`; none when the config cannot be read. */
export async function storageConnectOrigins(env: StoragePlatformEnv): Promise<string[]> {
	try {
		return (await getStorage(env)).connectOrigins();
	} catch {
		return [];
	}
}
