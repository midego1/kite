import { createAuditLog } from "@/lib/mailboxes/audit";
import { purgeColdOrphans } from "./cold";
import { fail, loadStore, type Actor, type Result, type StoresEnv } from "./stores";

/**
 * The manual "Delete leftovers" admin action (round-8 review: automatic orphan deletion was split out of the
 * cron into this, triggered from Admin → Storage): runs the same lease-fenced, grace-period and backup-window
 * checks the automatic pass used to run on its own, narrowed to this one store. Kept out of `stores.ts` itself
 * to stay clear of its line budget.
 */
export async function purgeStoreOrphans(env: StoresEnv, actor: Actor, id: string): Promise<Result<{ pruned: number }>> {
	const { store } = await loadStore(env, id);
	if (!store) return fail(404, "Store not found");
	const { pruned } = await purgeColdOrphans(env, id);
	await createAuditLog(env, {
		actorUserId: actor.id,
		action: "storage.orphans_purged",
		metadata: { storeId: id, pruned },
	});
	return { ok: true, pruned };
}
