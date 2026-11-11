import { COLD_STORAGE_CLASS, R2_IA_TARGET, type ColdRule } from "./cold-utils";
import { DEFAULT_STORE_ID } from "./config-utils";
import { findSource, copyObject, locationAwareSources, matchesExisting } from "./migration";
import { callStorageHook } from "./module-hooks";
import {
	claimLocationLease,
	clearOrphanCandidate,
	lookupObjectLocation,
	markOrphanCandidate,
	recordObjectLocation,
	releaseLocationLease,
	renewLocationLease,
	withLocationLease,
} from "./object-locations";
import type { Item } from "./cold-sources";
import type { ObjectStore, RoutableClass, Storage } from "./types";

type LocationEnv = { DB: D1Database };

/** The class's normal chain, widened by `locationAwareSources` with wherever a cold move may already have put `key`. */
function sourcesFor(
	env: LocationEnv,
	storage: Storage,
	objectClass: RoutableClass,
	key: string,
	target?: string,
): Promise<ObjectStore[]> {
	const chain = [...storage.readChain(objectClass), storage.store(DEFAULT_STORE_ID)!];
	return locationAwareSources(env, storage, chain, key, target);
}

/**
 * When the "already at target" shortcut finds the object there without ever copying anything, it got there
 * either through a recorded location or `locationAwareSources`' own direct probe of the rule's target, not
 * necessarily by following the class's normal chain. That chain can still separately hold a copy of the same
 * key — the one this object actually went cold from — which the shortcut never otherwise notices, deletes or
 * tracks (`m3`, round-8 review): it would sit there untracked forever, defeating cold storage for this object
 * without anyone ever finding out. Marks it a candidate instead of deleting it directly, since nothing fenced
 * this read against a concurrent writer; the normal lease-checked cleanup settles it safely later.
 */
async function markRedundantChainCopy(
	env: LocationEnv,
	storage: Storage,
	objectClass: RoutableClass,
	key: string,
	targetStoreId: string,
): Promise<void> {
	const chain = [...storage.readChain(objectClass), storage.store(DEFAULT_STORE_ID)!];
	for (const store of chain) {
		if (store.id === targetStoreId) continue;
		const head = await store.bucket.head(key).catch(() => null);
		if (head) {
			await markOrphanCandidate(env, { storeId: store.id, key, objectClass, movedAt: new Date() });
			return;
		}
	}
}

/**
 * On a refused record, never delete anything this mover has not itself recorded under a still-valid token
 * (`B4`): the refusal means someone else has held the lease since, and on this exact key and target that may
 * already be a second mover's own correctly recorded copy with its source already deleted; deleting it here
 * would leave nothing. Under a fresh claim, mark the target a candidate only while the live location does not
 * actually name it, so it is tracked rather than this mover destroying the only copy right now (only the
 * lease-holding leftover cleanup in `cold-leftovers.ts` deletes a tracked candidate). Best effort: if the fresh claim
 * itself loses the race, this mover leaves the target alone and lets whoever does hold it, or a later scan,
 * sort it out.
 */
async function deferUnrecordedCopy(
	env: LocationEnv,
	key: string,
	objectClass: RoutableClass,
	targetStoreId: string,
): Promise<void> {
	const recheck = await claimLocationLease(env, key);
	if (recheck === null || recheck === "none") return;
	try {
		const current = await lookupObjectLocation(env, key);
		if (!current || current.storeId !== targetStoreId) {
			await markOrphanCandidate(env, { storeId: targetStoreId, key, objectClass, movedAt: new Date() });
		}
	} finally {
		await releaseLocationLease(env, key, recheck.token);
	}
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
	const source = await findSource(await sourcesFor(env, storage, objectClass, item.key, rule.target), item.key);
	if (!source) throw new Error("Missing from every store in the read chain");
	if (rule.target === R2_IA_TARGET) {
		if (!source.store.capabilities.storageClasses.includes(COLD_STORAGE_CLASS)) return 0;
		// Fenced too (`m5`, round-9 review): a same-store rewrite still only ever records object_locations, and
		// an unfenced write here could overwrite a concurrent mover's own fenced record for a retargeted key the
		// same way the cross-store shortcut could before `m1`.
		return withLocationLease(
			env,
			item.key,
			{
				objectClass,
				storeId: source.store.id,
				storageClass: source.head.storageClass ?? null,
				size: source.head.size,
			},
			async (lease) => {
				if (source.head.storageClass === COLD_STORAGE_CLASS) {
					const recorded = await recordObjectLocation(
						env,
						{
							key: item.key,
							objectClass,
							storeId: source.store.id,
							storageClass: COLD_STORAGE_CLASS,
							size: source.head.size,
						},
						lease,
					);
					if (!recorded)
						throw new Error("Lost the location lease before the record could be attempted; it will be retried");
					return 0;
				}
				const copied = await copyObject(source.store, source.head, source.store, item.key, item.key, {
					storageClass: COLD_STORAGE_CLASS,
					onPart: lease
						? async () => {
								if (!(await renewLocationLease(env, item.key, lease.token)))
									throw new Error("Lost the location lease during the rewrite");
							}
						: undefined,
				});
				if (copied === null) throw new Error("The object disappeared from the store during the rewrite");
				if (lease && !(await renewLocationLease(env, item.key, lease.token)))
					throw new Error("Lost the location lease before the record could be attempted; it will be retried");
				const recorded = await recordObjectLocation(
					env,
					{ key: item.key, objectClass, storeId: source.store.id, storageClass: COLD_STORAGE_CLASS, size: copied },
					lease,
				);
				if (!recorded)
					throw new Error("Lost the location lease before the record could be attempted; it will be retried");
				return copied;
			},
		);
	}
	const target = storage.store(rule.target);
	if (!target) throw new Error("The target store is missing or blocked");
	if (source.store.id === rule.target) {
		// Fenced too (`m1`, round-8 review): an unfenced write here could silently overwrite a concurrent
		// mover's own fenced record of a different target for this same key, since a plain upsert with no
		// token at all passes the fenced one's own WHERE clause by never being asked to match it.
		return withLocationLease(
			env,
			item.key,
			{ objectClass, storeId: rule.target, storageClass: null, size: source.head.size },
			async (lease) => {
				const recorded = await recordObjectLocation(
					env,
					{ key: item.key, objectClass, storeId: rule.target, storageClass: null, size: source.head.size },
					lease,
				);
				if (!recorded)
					throw new Error("Lost the location lease before the record could be attempted; it will be retried");
				// The object was already at the target, found through a recorded location or the rule's own
				// target probe rather than necessarily the normal chain: that chain can still separately hold
				// a copy, the one this object actually went cold from, now redundant and otherwise untracked
				// forever (`m3`, round-8 review).
				await markRedundantChainCopy(env, storage, objectClass, item.key, rule.target);
				return 0;
			},
		);
	}
	// The lease (held through the verify, the record and the delete below, renewed as needed for a long copy)
	// fences this against a second concurrent mover of the exact same key (`B2`), the leftover cleanup
	// (`cold-leftovers.ts`) and a storage-migration purge, which all hold this same lease to delete a copy. A
	// lapsed lease aborts instead of silently losing the race that leaves (`B3`): the record below only lands
	// while it is still held, fenced in the same statement.
	// `initial` names the source, not the target (`B5`): nothing has been copied yet, so claiming by creating
	// a row (a never-before-cold key) must describe where the bytes truly are right now, or an aborted first
	// move leaves `object_locations` naming a store that never actually got anything.
	return withLocationLease(
		env,
		item.key,
		{
			objectClass,
			storeId: source.store.id,
			storageClass: source.head.storageClass ?? null,
			size: source.head.size,
		},
		async (lease) => {
			if (lease) await renewLocationLease(env, item.key, lease.token);
			const present = await target.bucket.head(item.key);
			let bytes = 0;
			if (!matchesExisting(source.head, present, source.store.id, target.id)) {
				const copied = await copyObject(source.store, source.head, target, item.key, item.key, {
					onPart: lease
						? async () => {
								if (!(await renewLocationLease(env, item.key, lease.token)))
									throw new Error("Lost the location lease during the copy");
							}
						: undefined,
				});
				if (copied === null) throw new Error("The object disappeared from the source store during the copy");
				bytes = copied;
			} else {
				bytes = present!.size;
			}
			const confirmed = await target.bucket.head(item.key);
			if (!confirmed || confirmed.size !== source.head.size)
				throw new Error("The copy on the target store does not match");
			// Renewed once more right here, after the copy (or the skip) and before the record: covers both a
			// single-part copy, which never goes through `onPart` above, and the gap after a multipart copy's
			// last part, its own completion and the two HEADs above (`B4`).
			if (lease && !(await renewLocationLease(env, item.key, lease.token)))
				throw new Error("Lost the location lease before the record could be attempted; it will be retried");
			// The location is recorded before the source copy is deleted: a crash in between leaves a harmless extra
			// copy at the old store rather than an object nothing points to (`sourcesFor` above also self-heals by
			// probing the rule's own target directly, in case the crash happened before this write ever lands).
			const recorded = await recordObjectLocation(
				env,
				{ key: item.key, objectClass, storeId: rule.target, storageClass: null, size: confirmed.size },
				lease,
			);
			if (!recorded) {
				// Never delete anything this mover has not itself recorded under a still-valid token (`B4`): the
				// refusal means someone else held the lease since, and may already have recorded this exact
				// target and deleted the source itself. Only mark the target a candidate, and only while the
				// live location does not actually name it, so the normal cleanup settles it safely later.
				await deferUnrecordedCopy(env, item.key, objectClass, rule.target);
				throw new Error("Lost the location lease before the move could be recorded; it will be retried");
			}
			// Belt and suspenders even though the record just succeeded under a lease that was still valid: confirm
			// the copy it now names is actually still there before trusting it enough to delete the only other one.
			if (!(await target.bucket.head(item.key))) {
				await recordObjectLocation(env, {
					key: item.key,
					objectClass,
					storeId: source.store.id,
					storageClass: null,
					size: source.head.size,
				});
				throw new Error("The target copy disappeared right after being recorded; kept the source instead");
			}
			await source.store.bucket.delete(item.key);
			// The mark `recordObjectLocation` just made for this exact copy was only ever a precaution for the
			// delete above failing; it did not, so there is nothing left for the orphan sweep to find here (`B1`).
			await clearOrphanCandidate(env, source.store.id, item.key);
			return bytes;
		},
	);
}

/**
 * Moves one Drive file by its own recorded store. `drive_items.store_id` is the normal source of truth for
 * where a file lives, but a restore can roll a row back to a store a sweep already moved the file away from
 * (the restored row names a store that no longer has it); `object_locations` (key `drive/<id>`, same as mail
 * and backups) survives that, since restoring a backup merges it rather than replacing it wholesale
 * (`MERGED_ON_RESTORE`), and `streamDriveFile` falls back to it and repairs the row. The location is recorded,
 * then the row is repointed (`markCold`, one file at a time, not batched after the whole page), before the old
 * copy is deleted: a crash in between leaves a harmless extra copy at the old store rather than nothing
 * pointing at either copy.
 */
export async function moveColdDriveObject(
	env: LocationEnv,
	storage: Storage,
	rule: ColdRule,
	item: Item & { storeId: string },
): Promise<{ bytes: number; moved: boolean }> {
	let storeId = item.storeId;
	let source = storage.store(storeId);
	if (!source) throw new Error("The file's store is missing or blocked");
	let head = await source.bucket.head(item.key);
	if (!head) {
		// A restore can roll drive_items.store_id back to a store a sweep already moved the file off of;
		// object_locations (recorded by this same cold move, below) survives that and still finds it, the same
		// fallback streamDriveFile and presignedDownload already get on a read. Repairing the row here means
		// the next sweep does not have to rediscover this too, instead of the move simply failing every time.
		const recovered = await lookupObjectLocation(env, item.key);
		const recoveredStore = recovered && storage.store(recovered.storeId);
		const recoveredHead = recoveredStore && (await recoveredStore.bucket.head(item.key));
		if (!recoveredStore || !recoveredHead) throw new Error("The file is missing from its recorded store");
		await callStorageHook("drive", "markCold", {
			ids: [item.id],
			storageClass: recoveredHead.storageClass ?? null,
			storeId: recoveredStore.id,
		});
		storeId = recoveredStore.id;
		source = recoveredStore;
		head = recoveredHead;
	}
	if (rule.target === R2_IA_TARGET) {
		if (!source.capabilities.storageClasses.includes(COLD_STORAGE_CLASS)) return { bytes: 0, moved: false };
		// Fenced too (`m5`, round-9 review): same reasoning as moveColdObject's own rewrite path.
		return withLocationLease(
			env,
			item.key,
			{ objectClass: "drive", storeId: source.id, storageClass: head.storageClass ?? null, size: head.size },
			async (lease) => {
				if (head.storageClass === COLD_STORAGE_CLASS) {
					// The rewrite already happened (maybe in an earlier sweep that crashed before this call
					// landed); repair the row and the location so neither stays stuck reporting the stale,
					// pre-rewrite state.
					const recorded = await recordObjectLocation(
						env,
						{
							key: item.key,
							objectClass: "drive",
							storeId: source.id,
							storageClass: COLD_STORAGE_CLASS,
							size: head.size,
						},
						lease,
					);
					if (!recorded)
						throw new Error("Lost the location lease before the record could be attempted; it will be retried");
					await callStorageHook("drive", "markCold", { ids: [item.id], storageClass: COLD_STORAGE_CLASS });
					return { bytes: 0, moved: true };
				}
				const copied = await copyObject(source, head, source, item.key, item.key, {
					storageClass: COLD_STORAGE_CLASS,
					onPart: lease
						? async () => {
								if (!(await renewLocationLease(env, item.key, lease.token)))
									throw new Error("Lost the location lease during the rewrite");
							}
						: undefined,
				});
				if (copied === null) throw new Error("The file disappeared from the store during the rewrite");
				if (lease && !(await renewLocationLease(env, item.key, lease.token)))
					throw new Error("Lost the location lease before the record could be attempted; it will be retried");
				const recorded = await recordObjectLocation(
					env,
					{ key: item.key, objectClass: "drive", storeId: source.id, storageClass: COLD_STORAGE_CLASS, size: copied },
					lease,
				);
				if (!recorded)
					throw new Error("Lost the location lease before the record could be attempted; it will be retried");
				await callStorageHook("drive", "markCold", { ids: [item.id], storageClass: COLD_STORAGE_CLASS });
				return { bytes: copied, moved: true };
			},
		);
	}
	const target = storage.store(rule.target);
	if (!target) throw new Error("The target store is missing or blocked");
	if (storeId === rule.target) {
		// Fenced too (`m1`, round-8 review): same reasoning as moveColdObject's own shortcut.
		return withLocationLease(
			env,
			item.key,
			{ objectClass: "drive", storeId: rule.target, storageClass: null, size: head.size },
			async (lease) => {
				const recorded = await recordObjectLocation(
					env,
					{ key: item.key, objectClass: "drive", storeId: rule.target, storageClass: null, size: head.size },
					lease,
				);
				if (!recorded)
					throw new Error("Lost the location lease before the record could be attempted; it will be retried");
				await callStorageHook("drive", "markCold", { ids: [item.id], storageClass: null, storeId: rule.target });
				return { bytes: 0, moved: true };
			},
		);
	}
	// Held through the verify, the record and the delete below, renewed as needed for a long copy, same
	// reasoning as moveColdObject (`B2`, `B3`): a lapsed lease aborts here instead of losing the race that
	// leaves. `initial` names the source, not the target, same reasoning as moveColdObject (`B5`).
	return withLocationLease(
		env,
		item.key,
		{ objectClass: "drive", storeId, storageClass: head.storageClass ?? null, size: head.size },
		async (lease) => {
			if (lease) await renewLocationLease(env, item.key, lease.token);
			const present = await target.bucket.head(item.key);
			const bytes = matchesExisting(head, present, source.id, target.id)
				? present!.size
				: await copyObject(source, head, target, item.key, item.key, {
						onPart: lease
							? async () => {
									if (!(await renewLocationLease(env, item.key, lease.token)))
										throw new Error("Lost the location lease during the copy");
								}
							: undefined,
					});
			if (bytes === null) throw new Error("The file disappeared from its store during the copy");
			const confirmed = await target.bucket.head(item.key);
			if (!confirmed || confirmed.size !== head.size) throw new Error("The copy on the target store does not match");
			// Renewed once more right here, same reasoning as moveColdObject (`B4`): covers a single-part copy
			// and the gap after a multipart copy's last part, its own completion and the two HEADs above.
			if (lease && !(await renewLocationLease(env, item.key, lease.token)))
				throw new Error("Lost the location lease before the record could be attempted; it will be retried");
			// The location is recorded before the row is repointed or the old copy is deleted, mirroring moveColdObject:
			// a crash from here on still leaves a path to the bytes, through object_locations if nothing else.
			const recorded = await recordObjectLocation(
				env,
				{ key: item.key, objectClass: "drive", storeId: rule.target, storageClass: null, size: confirmed.size },
				lease,
			);
			if (!recorded) {
				// Never delete anything this mover has not itself recorded under a still-valid token (`B4`):
				// see moveColdObject for the full reasoning.
				await deferUnrecordedCopy(env, item.key, "drive", rule.target);
				throw new Error("Lost the location lease before the move could be recorded; it will be retried");
			}
			// Belt and suspenders even though the record just succeeded under a lease that was still valid: confirm
			// the copy it now names is actually still there before repointing the row and deleting the old copy.
			if (!(await target.bucket.head(item.key))) {
				await recordObjectLocation(env, {
					key: item.key,
					objectClass: "drive",
					storeId,
					storageClass: null,
					size: head.size,
				});
				throw new Error("The target copy disappeared right after being recorded; kept the source instead");
			}
			const marked = await callStorageHook<{ updated: number }>("drive", "markCold", {
				ids: [item.id],
				storageClass: null,
				storeId: rule.target,
			});
			// The row may be gone by now (the file was trashed and purged, or deleted outright, since this item was
			// read); only delete the old copy once the row is confirmed repointed, never on the strength of the copy
			// alone, so a vanished row can never leave nothing pointing at either copy.
			if (!marked?.updated) throw new Error("The file's row is gone; its old copy was kept");
			await source.bucket.delete(item.key);
			// Only a precaution for that delete failing; it did not, so there is nothing left to track (`B1`).
			await clearOrphanCandidate(env, storeId, item.key);
			return { bytes, moved: true };
		},
	);
}
