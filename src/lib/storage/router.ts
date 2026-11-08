import { getStorage, RAW_ENV, type Proxied, type StoragePlatformEnv } from "./index";
import { objectClassOf } from "./object-classes-utils";
import { deleteObjectLocations, lookupObjectLocation, lookupObjectLocations } from "./object-locations";
import type { KiteBucket, ObjectStore, Storage } from "./types";

type MultipartOptions = Parameters<NonNullable<KiteBucket["createMultipartUpload"]>>[1];

/** The first store in the chain that has the object; a failing store is skipped unless no later one has it. */
async function firstHit<T>(chain: ObjectStore[], read: (store: ObjectStore) => Promise<T | null>): Promise<T | null> {
	let failure: unknown;
	for (const store of chain) {
		try {
			const found = await read(store);
			if (found) return found;
		} catch (error) {
			failure ??= error;
		}
	}
	if (failure) throw failure;
	return null;
}

function groupByClass(keys: string[]) {
	const groups = new Map<ReturnType<typeof objectClassOf>, string[]>();
	for (const key of keys) {
		const objectClass = objectClassOf(key);
		groups.set(objectClass, [...(groups.get(objectClass) ?? []), key]);
	}
	return groups;
}

/** The store a cold-moved key lives on, for the one extra lookup a chain miss takes (`cold.ts`, phase 3). */
function coldStoreOf(storage: Storage, location: { storeId: string } | null): ObjectStore | null {
	return location ? storage.store(location.storeId) : null;
}

function requireMultipart(store: ObjectStore) {
	const { createMultipartUpload, resumeMultipartUpload } = store.bucket;
	if (!createMultipartUpload || !resumeMultipartUpload)
		throw new Error("This store does not support multipart uploads");
	return {
		create: createMultipartUpload.bind(store.bucket),
		resume: resumeMultipartUpload.bind(store.bucket),
	};
}

/**
 * `env.BUCKET` once `withStorage` wraps the env: writes go to the class's active store, reads walk the chain
 * (active, previous while migrating, default), deletes reach all three stores. `system` keys and an
 * install without stores go straight to the binding: `system` keys without reading the config at all, the others
 * after one cached config read.
 * @public Exercised by the unit tests.
 */
export function createStorageRouter(env: StoragePlatformEnv): KiteBucket {
	const binding = env.BUCKET as unknown as KiteBucket;
	const storage = () => getStorage(env);
	const router = {
		async get(key: string, options?: R2GetOptions) {
			if (objectClassOf(key) === "system") return binding.get(key, options);
			const built = await storage();
			const hit = await firstHit(built.readChain(objectClassOf(key)), (store) => store.bucket.get(key, options));
			if (hit) return hit;
			return coldStoreOf(built, await lookupObjectLocation(env, key))?.bucket.get(key, options) ?? null;
		},
		async head(key: string) {
			if (objectClassOf(key) === "system") return binding.head(key);
			const built = await storage();
			const hit = await firstHit(built.readChain(objectClassOf(key)), (store) => store.bucket.head(key));
			if (hit) return hit;
			return coldStoreOf(built, await lookupObjectLocation(env, key))?.bucket.head(key) ?? null;
		},
		async put(key: string, value: Parameters<KiteBucket["put"]>[1], options?: R2PutOptions) {
			if (objectClassOf(key) === "system") return binding.put(key, value, options);
			return (await storage()).storeForKey(key).bucket.put(key, value, options);
		},
		async delete(keys: string | string[]) {
			const list = Array.isArray(keys) ? keys : [keys];
			const built = await storage();
			for (const [objectClass, group] of groupByClass(list)) {
				for (const store of built.deleteTargets(objectClass)) await store.bucket.delete(group);
			}
			// A cold move can park a key on a store outside the normal chain (`cold.ts`); reach it too, and
			// drop the record once the object itself is gone, so it never blocks deleting that store later.
			const locations = await lookupObjectLocations(env, list);
			if (locations.size) {
				const byStore = new Map<string, string[]>();
				for (const [key, storeId] of locations) byStore.set(storeId, [...(byStore.get(storeId) ?? []), key]);
				for (const [storeId, storeKeys] of byStore) await built.store(storeId)?.bucket.delete(storeKeys);
				await deleteObjectLocations(env, list);
			}
		},
		async list(options?: R2ListOptions) {
			const store = (await storage()).storeForKey(options?.prefix ?? "");
			if (!store.bucket.list) throw new Error("This store cannot list objects");
			return store.bucket.list(options);
		},
		async createMultipartUpload(key: string, options?: MultipartOptions) {
			return requireMultipart((await storage()).storeForKey(key)).create(key, options);
		},
		resumeMultipartUpload(key: string, uploadId: string) {
			const upload = async () => requireMultipart((await storage()).storeForKey(key)).resume(key, uploadId);
			return {
				key,
				uploadId,
				uploadPart: async (...args: Parameters<R2MultipartUpload["uploadPart"]>) =>
					(await upload()).uploadPart(...args),
				abort: async () => (await upload()).abort(),
				complete: async (parts: R2UploadedPart[]) => (await upload()).complete(parts),
			};
		},
	};
	return router as unknown as KiteBucket;
}

/**
 * Installs the storage router as `env.BUCKET`. Worker bindings cannot be spread, so this is a Proxy (the pattern
 * of Mailflare 83ade98 `withStorage`); every other property is read from the original env. Idempotent: a wrapped
 * env is returned unchanged, and an env without `BUCKET` or `DB` is returned as it is.
 */
const wrapped = new WeakMap<object, object>();

export function withStorage<T extends object>(env: T): T {
	const candidate = env as T & Partial<Pick<CloudflareEnv, "BUCKET" | "DB">> & Proxied;
	if (!candidate || candidate[RAW_ENV] || !candidate.BUCKET || !candidate.DB) return env;
	const existing = wrapped.get(env);
	if (existing) return existing as T;
	let router: KiteBucket | undefined;
	const proxy = new Proxy(env, {
		get(target, property) {
			if (property === RAW_ENV) return target;
			if (property === "BUCKET") return (router ??= createStorageRouter(target as unknown as StoragePlatformEnv));
			return Reflect.get(target, property);
		},
	});
	wrapped.set(env, proxy);
	return proxy;
}
