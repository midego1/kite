import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { storageMigrations } from "@/db/schema/storage";
import { isNoSuchTableError } from "@/lib/modules/state-utils";
import { isRoutableClass } from "./config-utils";
import { parseCursor } from "./migration-utils";
import { renewLocationLease, withPurgeLease } from "./object-locations";
import type { ObjectStore, RoutableClass } from "./types";

type Job = typeof storageMigrations.$inferSelect;

/**
 * Deletes one key's old copy for a purge, only after it is confirmed on the new store, and only under the key's
 * location lease (`withPurgeLease`; round-10 review, `B7`): a cold rule may archive into the very store a
 * migration moved away from, and a cold move copying the key back there holds that lease from its copy through
 * its own source delete, so without it the purge could delete the copy the mover just recorded while the mover
 * deletes the other one. A key whose location names the old store is the live cold copy, never a migration
 * leftover, and is skipped; a key someone else holds is kept for now and counted as an error.
 */
export async function purgeOldCopy(
	env: { DB: D1Database },
	from: ObjectStore,
	to: ObjectStore,
	objectClass: RoutableClass,
	item: { key: string; size: number | null },
): Promise<void> {
	const outcome = await withPurgeLease(
		env,
		item.key,
		{ objectClass, storeId: to.id, size: item.size ?? 0 },
		async ({ lease, storeId }) => {
			if (storeId === from.id) return;
			const present = await to.bucket.head(item.key);
			const old = await from.bucket.head(item.key);
			if (!old) return;
			if (!present || present.size !== old.size) throw new Error("Not complete on the new store; kept on the old one");
			if (lease && !(await renewLocationLease(env, item.key, lease.token)))
				throw new Error("Lost the location lease before the delete; kept on the old store");
			await from.bucket.delete(item.key);
		},
	);
	if (outcome === "busy") throw new Error("A cold storage move is working on this object; kept on the old store");
}

/**
 * The newest migration still moving `storeId`'s objects away, or finished but with its old copies there not yet
 * deleted (any phase short of `purged`, cancelled jobs aside, since a failed one can be retried into its purge):
 * a cold rule must not archive into a store a purge may still empty (round-10 review, `B7`). Null before the
 * table exists.
 */
export async function unpurgedMigrationFrom(env: { DB: D1Database }, storeId: string): Promise<Job | null> {
	let jobs: Job[];
	try {
		jobs = await getDb(env)
			.select()
			.from(storageMigrations)
			.where(eq(storageMigrations.fromStoreId, storeId))
			.orderBy(desc(storageMigrations.createdAt));
	} catch (error) {
		if (isNoSuchTableError(error)) return null;
		throw error;
	}
	return (
		jobs.find(
			(job) =>
				job.status !== "cancelled" &&
				isRoutableClass(job.objectClass) &&
				parseCursor(job.cursor, job.objectClass).phase !== "purged",
		) ?? null
	);
}
