import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { storageMigrations, storageRoutes } from "@/db/schema/storage";
import { createAuditLog } from "@/lib/mailboxes/audit";
import { isNodeRuntime } from "@/lib/runtime";
import { clearStorageConfigCache, readStorageConfig } from "./config";
import { DEFAULT_STORE_ID, type StoreRecord } from "./config-utils";
import { isActiveMigration, purgeConfirmationMatches } from "./migration-utils";
import {
	actOnStorageMigration,
	activeMigrationFor,
	queueStorageMigration,
	startStorageMigrationPurge,
} from "./migration";
import {
	candidateOf,
	checkedRecently,
	fail,
	migrationView,
	recordCheck,
	type Actor,
	type Result,
	type StoresEnv,
} from "./stores";
import type { RoutableClass } from "./types";
import { reportSummary } from "./validate-utils";
import { validateStore, validateStoreCors } from "./validate";

export type RouteSwitchInput = { storeId: unknown; migrate?: unknown; copyBackups?: unknown };

/**
 * Points a class at a store. New writes go there (other isolates within 30 s), reads fall back to the old store,
 * and with `migrate` a job copies the existing objects. The target must have passed validation within the hour,
 * and for Drive its CORS rule must let browsers upload directly.
 */
export async function switchRoute(
	env: StoresEnv,
	actor: Actor,
	objectClass: RoutableClass,
	body: RouteSwitchInput,
	requestOrigin: string,
): Promise<Result<{ migrationId: string | null }>> {
	if (typeof body.storeId !== "string" || !body.storeId) return fail(400, "Choose a store");
	const targetId = body.storeId;
	const config = await readStorageConfig(env);
	const route = config.routes.get(objectClass);
	const currentId = route?.storeId ?? DEFAULT_STORE_ID;
	if (await activeMigrationFor(env, objectClass))
		return fail(409, "A migration for this class is running; cancel it or wait for it to finish");
	const previous = route?.previousStoreId;
	if (targetId === currentId) return copyLeftovers(env, actor, objectClass, currentId, previous, body.migrate === true);
	if (previous && previous !== DEFAULT_STORE_ID && previous !== targetId)
		return fail(409, "Objects still live on the store before the current one; finish that move first");
	const usable = await checkTarget(env, config.stores.get(targetId), targetId, objectClass, requestOrigin);
	if (!usable.ok) return usable;
	const migrate = body.migrate === true && (objectClass !== "backups" || body.copyBackups !== false);
	const db = getDb(env);
	const now = new Date();
	await db
		.insert(storageRoutes)
		.values({ objectClass, storeId: targetId, previousStoreId: currentId, updatedAt: now })
		.onConflictDoUpdate({
			target: storageRoutes.objectClass,
			set: { storeId: targetId, previousStoreId: currentId, updatedAt: now },
		});
	clearStorageConfigCache();
	const migrationId = migrate
		? await queueStorageMigration(env, {
				objectClass,
				fromStoreId: currentId,
				toStoreId: targetId,
				createdByUserId: actor.id,
			})
		: null;
	await createAuditLog(env, {
		actorUserId: actor.id,
		action: "storage.route_switched",
		metadata: { objectClass, fromStoreId: currentId, toStoreId: targetId, migrationId },
	});
	return { ok: true, migrationId };
}

/** A switch made without copying leaves the old store in the read chain; this copies its objects later. */
async function copyLeftovers(
	env: StoresEnv,
	actor: Actor,
	objectClass: RoutableClass,
	currentId: string,
	previous: string | null | undefined,
	migrate: boolean,
): Promise<Result<{ migrationId: string | null }>> {
	if (!migrate || !previous || previous === currentId) return fail(409, "This class already uses that store");
	const migrationId = await queueStorageMigration(env, {
		objectClass,
		fromStoreId: previous,
		toStoreId: currentId,
		createdByUserId: actor.id,
	});
	await createAuditLog(env, {
		actorUserId: actor.id,
		action: "storage.migration_started",
		metadata: { objectClass, fromStoreId: previous, toStoreId: currentId, migrationId },
	});
	return { ok: true, migrationId };
}

async function checkTarget(
	env: StoresEnv,
	target: StoreRecord | undefined,
	targetId: string,
	objectClass: RoutableClass,
	requestOrigin: string,
): Promise<Result<object>> {
	if (targetId === DEFAULT_STORE_ID) return { ok: true };
	if (!target || target.sameAsBinding) return fail(404, "Store not found");
	if (target.blocked) return fail(409, target.blocked);
	return ensureFreshValidation(env, target, objectClass, requestOrigin);
}

async function ensureFreshValidation(
	env: StoresEnv,
	store: StoreRecord,
	objectClass: RoutableClass,
	requestOrigin: string,
): Promise<Result<object>> {
	let candidate;
	try {
		candidate = await candidateOf(env, store);
	} catch {
		return fail(409, "The saved credentials cannot be opened; APP_ENCRYPTION_KEY may have changed");
	}
	if (!checkedRecently(store)) {
		const report = await validateStore(env, candidate, requestOrigin);
		await recordCheck(env, store, report);
		if (!report.ok) return fail(422, reportSummary(report) ?? "The store did not pass the checks", { report });
		if (objectClass === "drive" && !report.cors)
			return fail(422, "Browsers cannot upload to this store yet; apply the CORS rule first", { report });
		return { ok: true };
	}
	if (objectClass === "drive") {
		const cors = await validateStoreCors(candidate, requestOrigin);
		if (!cors.ok)
			return fail(422, "Browsers cannot upload to this store yet; apply the CORS rule first", { steps: cors.steps });
	}
	return { ok: true };
}

export type MigrationActionInput = { action?: unknown; confirm?: unknown };

/** Cancel, finish, retry, or delete the old copies (which needs the old store's name typed). */
export async function runMigrationAction(
	env: StoresEnv,
	actor: Actor,
	id: string,
	body: MigrationActionInput,
): Promise<Result<{ migration: ReturnType<typeof migrationView> }>> {
	const [job] = await getDb(env).select().from(storageMigrations).where(eq(storageMigrations.id, id)).limit(1);
	if (!job) return fail(404, "Migration not found");
	const action = body.action;
	if (action === "purge-source") {
		const config = await readStorageConfig(env);
		const name =
			job.fromStoreId === DEFAULT_STORE_ID
				? isNodeRuntime(env)
					? "Local files"
					: "Cloudflare R2"
				: config.stores.get(job.fromStoreId)?.name;
		if (!name) return fail(404, "The old store no longer exists");
		if (!purgeConfirmationMatches(body.confirm, name)) return fail(400, `Type ${name} to confirm`);
		const result = await startStorageMigrationPurge(env, job);
		if (result.ok)
			await createAuditLog(env, {
				actorUserId: actor.id,
				action: "storage.migration_purged",
				metadata: { migrationId: job.id, objectClass: job.objectClass, storeId: job.fromStoreId },
			});
		return result.ok ? { ok: true as const, migration: migrationView(result.job) } : result;
	}
	if (action !== "cancel" && action !== "finish" && action !== "retry")
		return fail(400, "Action is cancel, finish, retry or purge-source");
	const result = await actOnStorageMigration(env, job, action);
	if (result.ok && action === "cancel" && isActiveMigration(job.status))
		await createAuditLog(env, {
			actorUserId: actor.id,
			action: "storage.migration_cancelled",
			metadata: { migrationId: job.id, objectClass: job.objectClass },
		});
	return result.ok ? { ok: true as const, migration: migrationView(result.job) } : result;
}

export async function migrationStatus(env: StoresEnv, id: string) {
	const [job] = await getDb(env).select().from(storageMigrations).where(eq(storageMigrations.id, id)).limit(1);
	return job ? migrationView(job) : null;
}
