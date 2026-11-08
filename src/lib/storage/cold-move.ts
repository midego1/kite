import { COLD_STORAGE_CLASS, R2_IA_TARGET, type ColdRule } from "./cold-utils";
import { DEFAULT_STORE_ID } from "./config-utils";
import { findSource, copyObject } from "./migration";
import { lookupObjectLocation, recordObjectLocation } from "./object-locations";
import type { Item } from "./cold-sources";
import type { ObjectStore, RoutableClass, Storage } from "./types";

type LocationEnv = { DB: D1Database };

/**
 * Where a key currently lives: wherever an earlier cold move recorded (which may be neither the class's active
 * nor its previous store, if the rule's target changed since), then the class's active read chain.
 */
async function sourcesFor(
	env: LocationEnv,
	storage: Storage,
	objectClass: RoutableClass,
	key: string,
): Promise<ObjectStore[]> {
	const location = await lookupObjectLocation(env, key);
	const recorded = location && storage.store(location.storeId);
	const chain = [...storage.readChain(objectClass), storage.store(DEFAULT_STORE_ID)!];
	return [...new Set(recorded ? [recorded, ...chain] : chain)];
}

/**
 * Moves one mail or backups object: a same-store rewrite to a cheaper storage class (`R2_IA_TARGET`), or a copy
 * to another store, verified by HEAD before the source copy is ever deleted.
 */
export async function moveColdObject(
	env: LocationEnv,
	storage: Storage,
	objectClass: RoutableClass,
	rule: ColdRule,
	item: Item,
): Promise<number> {
	const source = await findSource(await sourcesFor(env, storage, objectClass, item.key), item.key);
	if (!source) throw new Error("Missing from every store in the read chain");
	if (rule.target === R2_IA_TARGET) {
		if (!source.store.capabilities.storageClasses.includes(COLD_STORAGE_CLASS)) return 0;
		if (source.head.storageClass === COLD_STORAGE_CLASS) {
			await recordObjectLocation(env, {
				key: item.key,
				objectClass,
				storeId: source.store.id,
				storageClass: COLD_STORAGE_CLASS,
				size: source.head.size,
			});
			return 0;
		}
		const copied = await copyObject(source.store.bucket, source.head, source.store, item.key, item.key, {
			storageClass: COLD_STORAGE_CLASS,
		});
		if (copied === null) throw new Error("The object disappeared from the store during the rewrite");
		await recordObjectLocation(env, {
			key: item.key,
			objectClass,
			storeId: source.store.id,
			storageClass: COLD_STORAGE_CLASS,
			size: copied,
		});
		return copied;
	}
	const target = storage.store(rule.target);
	if (!target) throw new Error("The target store is missing or blocked");
	if (source.store.id === rule.target) {
		await recordObjectLocation(env, {
			key: item.key,
			objectClass,
			storeId: rule.target,
			storageClass: null,
			size: source.head.size,
		});
		return 0;
	}
	const present = await target.bucket.head(item.key);
	let bytes = 0;
	if (!present || present.size !== source.head.size) {
		const copied = await copyObject(source.store.bucket, source.head, target, item.key);
		if (copied === null) throw new Error("The object disappeared from the source store during the copy");
		bytes = copied;
	} else {
		bytes = present.size;
	}
	const confirmed = await target.bucket.head(item.key);
	if (!confirmed || confirmed.size !== source.head.size) throw new Error("The copy on the target store does not match");
	await source.store.bucket.delete(item.key);
	await recordObjectLocation(env, {
		key: item.key,
		objectClass,
		storeId: rule.target,
		storageClass: null,
		size: confirmed.size,
	});
	return bytes;
}

/** Moves one Drive file by its own recorded store, since Drive's row (not a routed class) is its source of truth. */
export async function moveColdDriveObject(
	storage: Storage,
	rule: ColdRule,
	item: Item & { storeId: string },
): Promise<{ bytes: number; moved: boolean }> {
	const source = storage.store(item.storeId);
	if (!source) throw new Error("The file's store is missing or blocked");
	const head = await source.bucket.head(item.key);
	if (!head) throw new Error("The file is missing from its recorded store");
	if (rule.target === R2_IA_TARGET) {
		if (!source.capabilities.storageClasses.includes(COLD_STORAGE_CLASS)) return { bytes: 0, moved: false };
		if (head.storageClass === COLD_STORAGE_CLASS) return { bytes: 0, moved: true };
		const copied = await copyObject(source.bucket, head, source, item.key, item.key, {
			storageClass: COLD_STORAGE_CLASS,
		});
		if (copied === null) throw new Error("The file disappeared from the store during the rewrite");
		return { bytes: copied, moved: true };
	}
	const target = storage.store(rule.target);
	if (!target) throw new Error("The target store is missing or blocked");
	if (item.storeId === rule.target) return { bytes: 0, moved: true };
	const present = await target.bucket.head(item.key);
	const bytes =
		present && present.size === head.size ? present.size : await copyObject(source.bucket, head, target, item.key);
	if (bytes === null) throw new Error("The file disappeared from its store during the copy");
	const confirmed = await target.bucket.head(item.key);
	if (!confirmed || confirmed.size !== head.size) throw new Error("The copy on the target store does not match");
	await source.bucket.delete(item.key);
	return { bytes, moved: true };
}
