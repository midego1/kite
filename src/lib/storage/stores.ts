import { and, eq, inArray, or } from "drizzle-orm";
import { getDb } from "@/db";
import { storageMigrations, storageStores } from "@/db/schema/storage";
import { newId } from "@/lib/ids";
import { createAuditLog } from "@/lib/mailboxes/audit";
import { isNodeRuntime } from "@/lib/runtime";
import { isSealed, sealSetting } from "@/lib/security/secret-box";
import {
	clearStorageConfigCache,
	endpointPolicyFor,
	openStoreCredentials,
	readStorageConfig,
	storageTablesReady,
} from "./config";
import {
	DEFAULT_STORE_ID,
	ENVIRONMENT_STORE_ID,
	keyHint,
	ROUTABLE_CLASSES,
	routesUsingStore,
	type StorageConfig,
	type StoreRecord,
} from "./config-utils";
import { storedEndpoint } from "./endpoint-utils";
import { ACTIVE_MIGRATION_STATUSES, VALIDATION_FRESH_MS } from "./migration-utils";
import { listStorageMigrations } from "./migration";
import { callStorageHook } from "./module-hooks";
import { S3Bucket } from "./s3-bucket";
import { corsRuleJson } from "./s3-utils";
import { presetFor } from "./s3-presets-utils";
import { corsOrigins, needsRevalidation, parseStoreInput, type StoreInput } from "./store-input-utils";
import type { RoutableClass, S3Credentials } from "./types";
import { reportSummary, type ValidationReport, type ValidationStep } from "./validate-utils";
import { validateStore, validateStoreCors } from "./validate";

export type StoresEnv = CloudflareEnv;
export type Actor = { id: string };
export type Failure = {
	ok: false;
	status: number;
	error: string;
	report?: ValidationReport;
	steps?: ValidationStep[];
	/** The form field a 400 is about, so the dialog shows the message under it. */
	field?: string;
};
export type Result<T> = ({ ok: true } & T) | Failure;

export const fail = (status: number, error: string, extra: Partial<Failure> = {}): Failure => ({
	ok: false,
	status,
	error,
	...extra,
});

export type StoreView = {
	id: string;
	name: string;
	provider: string;
	endpoint: string;
	region: string;
	bucket: string;
	addressing: string;
	/** The last four characters of the access key id; the only part of a credential ever returned. */
	keyHint: string;
	sameAsBinding: boolean;
	status: string;
	lastCheckedAt: string | null;
	lastError: string | null;
	source: "database" | "environment";
	blocked: string | null;
	usedBy: RoutableClass[];
};

async function keyHintOf(env: StoresEnv, store: StoreRecord): Promise<string> {
	try {
		return keyHint((await openStoreCredentials(env, store)).accessKeyId);
	} catch {
		return "";
	}
}

async function storeView(env: StoresEnv, config: StorageConfig, store: StoreRecord): Promise<StoreView> {
	return {
		id: store.id,
		name: store.name,
		provider: store.provider,
		endpoint: storedEndpoint(store.location),
		region: store.location.region,
		bucket: store.location.bucket,
		addressing: store.location.addressing,
		keyHint: await keyHintOf(env, store),
		sameAsBinding: store.sameAsBinding,
		status: store.status,
		lastCheckedAt: store.lastCheckedAt?.toISOString() ?? null,
		lastError: store.lastError,
		source: store.source,
		blocked: store.blocked,
		usedBy: routesUsingStore(config, store.id),
	};
}

type MigrationRow = typeof storageMigrations.$inferSelect;

export function migrationView(job: MigrationRow) {
	const cursor = (() => {
		try {
			return JSON.parse(job.cursor ?? "{}") as { phase?: string };
		} catch {
			return {};
		}
	})();
	return {
		id: job.id,
		objectClass: job.objectClass,
		fromStoreId: job.fromStoreId,
		toStoreId: job.toStoreId,
		status: job.status,
		phase: cursor.phase ?? "copy",
		objectsTotal: job.objectsTotal,
		objectsDone: job.objectsDone,
		bytesDone: job.bytesDone,
		errors: job.errors,
		lastError: job.lastError,
		createdAt: job.createdAt.toISOString(),
		startedAt: job.startedAt?.toISOString() ?? null,
		finishedAt: job.finishedAt?.toISOString() ?? null,
	};
}

async function sumOf(env: StoresEnv, sql: string): Promise<{ objects: number; bytes: number }> {
	try {
		const row = await env.DB.prepare(sql).first<{ objects: number; bytes: number | null }>();
		return { objects: Number(row?.objects ?? 0), bytes: Number(row?.bytes ?? 0) };
	} catch {
		return { objects: 0, bytes: 0 };
	}
}

/** Objects and bytes per class from D1; raw messages have no recorded size, so mail bytes cover attachments only. */
async function usageByClass(env: StoresEnv) {
	const [raws, attachments, backups, drive] = await Promise.all([
		sumOf(env, "SELECT count(*) AS objects, 0 AS bytes FROM messages WHERE raw_r2_key IS NOT NULL"),
		sumOf(env, "SELECT count(*) AS objects, sum(size) AS bytes FROM message_attachments"),
		sumOf(env, "SELECT count(*) AS objects, sum(size) AS bytes FROM backups WHERE r2_key IS NOT NULL"),
		callStorageHook<{ objects: number; bytes: number }>("drive", "usage", {}).catch(() => null),
	]);
	return {
		mail: { objects: raws.objects + attachments.objects, bytes: attachments.bytes },
		drive: { objects: drive?.objects ?? 0, bytes: drive?.bytes ?? 0 },
		backups,
	};
}

/** Everything the Storage page shows; nothing in it is a secret. */
export async function storageOverview(env: StoresEnv) {
	const config = await readStorageConfig(env);
	const stores = await Promise.all([...config.stores.values()].map((store) => storeView(env, config, store)));
	const policy = endpointPolicyFor(env);
	return {
		defaultStore: {
			id: DEFAULT_STORE_ID,
			name: isNodeRuntime(env) ? "Local files" : "Cloudflare R2",
			kind: isNodeRuntime(env) ? "files" : "r2",
			directUploads: stores.some((store) => store.sameAsBinding && !store.blocked),
		},
		stores,
		routes: ROUTABLE_CLASSES.map((objectClass) => {
			const route = config.routes.get(objectClass);
			return {
				objectClass,
				storeId: route?.storeId ?? DEFAULT_STORE_ID,
				previousStoreId: route?.previousStoreId ?? null,
			};
		}),
		migrations: (await listStorageMigrations(env)).map(migrationView),
		usage: await usageByClass(env),
		encryptionReady: !!env.APP_ENCRYPTION_KEY?.trim(),
		migrationPending: !(await storageTablesReady(env)),
		endpointPolicy: { allowInsecure: policy.allowInsecure, allowPrivate: policy.allowPrivate },
		runtime: isNodeRuntime(env) ? "node" : "workers",
	};
}

async function loadStore(env: StoresEnv, id: string): Promise<{ config: StorageConfig; store: StoreRecord | null }> {
	const config = await readStorageConfig(env);
	return { config, store: config.stores.get(id) ?? null };
}

async function sealCredentials(env: StoresEnv, credentials: S3Credentials): Promise<string | null> {
	const sealed = await sealSetting(env, JSON.stringify(credentials));
	return isSealed(sealed) ? sealed : null;
}

const ENCRYPTION_REQUIRED =
	"Set APP_ENCRYPTION_KEY before adding a store: store credentials are only ever saved encrypted.";

function originsFor(env: StoresEnv, requestOrigin: string): string[] {
	return corsOrigins(requestOrigin, env.APP_URL);
}

async function onlyOneBindingKeyPair(env: StoresEnv, exceptId: string | null): Promise<boolean> {
	const rows = await getDb(env)
		.select({ id: storageStores.id })
		.from(storageStores)
		.where(eq(storageStores.sameAsBinding, true));
	return rows.every((row) => row.id === exceptId);
}

/** Validates (spec 4.5) and saves a new store; a failed check answers 422 with the step report. */
export async function createStore(
	env: StoresEnv,
	actor: Actor,
	raw: unknown,
	requestOrigin: string,
): Promise<Result<{ store: StoreView; report: ValidationReport }>> {
	if (!env.APP_ENCRYPTION_KEY?.trim()) return fail(409, ENCRYPTION_REQUIRED);
	const parsed = parseStoreInput(raw);
	if (!parsed.ok) return fail(400, parsed.error, parsed.field ? { field: parsed.field } : {});
	const input = parsed.value;
	if (!input.credentials) return fail(400, "Enter the access key ID and the secret");
	if (input.sameAsBinding && !(await onlyOneBindingKeyPair(env, null)))
		return fail(409, "The default store already has R2 S3 API keys; edit them instead");
	const report = await validateStore(env, { ...input, credentials: input.credentials }, requestOrigin);
	if (!report.ok) return fail(422, reportSummary(report) ?? "The store did not pass the checks", { report });
	const sealed = await sealCredentials(env, input.credentials);
	if (!sealed) return fail(409, ENCRYPTION_REQUIRED);
	const id = newId("sto");
	const now = new Date();
	await getDb(env)
		.insert(storageStores)
		.values({
			id,
			name: input.name,
			provider: input.provider,
			endpoint: storedEndpoint(input.location),
			region: input.location.region,
			bucket: input.location.bucket,
			addressing: input.location.addressing,
			credentials: sealed,
			sameAsBinding: input.sameAsBinding,
			status: "ok",
			lastCheckedAt: now,
			lastError: null,
			createdAt: now,
			updatedAt: now,
		});
	clearStorageConfigCache();
	await createAuditLog(env, {
		actorUserId: actor.id,
		action: "storage.store_created",
		metadata: auditMetadata(id, input),
	});
	const { config, store } = await loadStore(env, id);
	return { ok: true, store: await storeView(env, config, store!), report };
}

function auditMetadata(id: string | null, input: Pick<StoreInput, "provider" | "location" | "sameAsBinding">) {
	return {
		storeId: id,
		provider: input.provider,
		endpoint: input.location.endpoint,
		bucket: input.location.bucket,
		sameAsBinding: input.sameAsBinding,
	};
}

/** An edit re-runs the validation whenever it changes where or how the store is reached. */
export async function updateStore(
	env: StoresEnv,
	actor: Actor,
	id: string,
	raw: unknown,
	requestOrigin: string,
): Promise<Result<{ store: StoreView; report: ValidationReport | null }>> {
	if (id === ENVIRONMENT_STORE_ID) return fail(409, "This store comes from STORAGE_S3_* variables; change them there");
	if (!env.APP_ENCRYPTION_KEY?.trim()) return fail(409, ENCRYPTION_REQUIRED);
	const { store: existing } = await loadStore(env, id);
	if (!existing) return fail(404, "Store not found");
	const parsed = parseStoreInput(raw, existing);
	if (!parsed.ok) return fail(400, parsed.error, parsed.field ? { field: parsed.field } : {});
	const input = parsed.value;
	if (input.sameAsBinding !== existing.sameAsBinding)
		return fail(409, "Add a new store instead of changing what this one is for");
	let report: ValidationReport | null = null;
	let sealed: string | null = null;
	if (needsRevalidation(existing, input)) {
		let credentials: S3Credentials;
		try {
			credentials = input.credentials ?? (await openStoreCredentials(env, existing));
		} catch {
			return fail(409, "The saved credentials cannot be opened; enter the key pair again");
		}
		report = await validateStore(env, { ...input, credentials }, requestOrigin);
		if (!report.ok) return fail(422, reportSummary(report) ?? "The store did not pass the checks", { report });
		if (input.credentials) {
			sealed = await sealCredentials(env, input.credentials);
			if (!sealed) return fail(409, ENCRYPTION_REQUIRED);
		}
	}
	const now = new Date();
	await getDb(env)
		.update(storageStores)
		.set({
			name: input.name,
			provider: input.provider,
			endpoint: storedEndpoint(input.location),
			region: input.location.region,
			bucket: input.location.bucket,
			addressing: input.location.addressing,
			...(sealed ? { credentials: sealed } : {}),
			...(report ? { status: "ok" as const, lastCheckedAt: now, lastError: null } : {}),
			updatedAt: now,
		})
		.where(eq(storageStores.id, id));
	clearStorageConfigCache();
	await createAuditLog(env, {
		actorUserId: actor.id,
		action: "storage.store_updated",
		metadata: { ...auditMetadata(id, input), credentialsChanged: !!input.credentials },
	});
	const { config, store } = await loadStore(env, id);
	return { ok: true, store: await storeView(env, config, store!), report };
}

/** Refused while a route names the store, a Drive file records it, or a running migration uses it. */
export async function deleteStore(env: StoresEnv, actor: Actor, id: string): Promise<Result<object>> {
	if (id === ENVIRONMENT_STORE_ID) return fail(409, "This store comes from STORAGE_S3_* variables; unset them instead");
	const { config, store } = await loadStore(env, id);
	if (!store) return fail(404, "Store not found");
	const routed = routesUsingStore(config, id);
	if (routed.length) return fail(409, `Still used for ${routed.join(", ")}; switch those to another store first`);
	const driveFiles = (await callStorageHook<{ count: number }>("drive", "countOnStore", { storeId: id }))?.count ?? 0;
	if (driveFiles > 0) return fail(409, `${driveFiles} Drive files are still on this store; migrate them first`);
	const [migration] = await getDb(env)
		.select({ id: storageMigrations.id })
		.from(storageMigrations)
		.where(
			and(
				inArray(storageMigrations.status, [...ACTIVE_MIGRATION_STATUSES]),
				or(eq(storageMigrations.fromStoreId, id), eq(storageMigrations.toStoreId, id)),
			),
		)
		.limit(1);
	if (migration) return fail(409, "A running migration uses this store; cancel it or let it finish first");
	await getDb(env).delete(storageStores).where(eq(storageStores.id, id));
	clearStorageConfigCache();
	await createAuditLog(env, {
		actorUserId: actor.id,
		action: "storage.store_deleted",
		metadata: { storeId: id, provider: store.provider, bucket: store.location.bucket },
	});
	return { ok: true };
}

export async function candidateOf(env: StoresEnv, store: StoreRecord) {
	const credentials = await openStoreCredentials(env, store);
	return { provider: store.provider, location: store.location, credentials };
}

/** Runs the checklist against a saved store and records the outcome on its row. */
export async function testStore(
	env: StoresEnv,
	id: string,
	requestOrigin: string,
): Promise<Result<{ report: ValidationReport }>> {
	const { store } = await loadStore(env, id);
	if (!store) return fail(404, "Store not found");
	let candidate;
	try {
		candidate = await candidateOf(env, store);
	} catch {
		return fail(409, "The saved credentials cannot be opened; APP_ENCRYPTION_KEY may have changed");
	}
	const report = await validateStore(env, candidate, requestOrigin);
	await recordCheck(env, store, report);
	return { ok: true, report };
}

function storeIdOf(raw: unknown): string | null {
	const id = raw && typeof raw === "object" ? (raw as { storeId?: unknown }).storeId : undefined;
	return typeof id === "string" && id ? id : null;
}

/**
 * Test connection: the checklist on the form as typed, without saving anything (spec 4.5). On an edit
 * (`storeId`), a blank key pair uses the saved one. The audit row names the store's location and outcome, never
 * a credential.
 */
export async function testStoreInput(
	env: StoresEnv,
	actor: Actor,
	raw: unknown,
	requestOrigin: string,
): Promise<Result<{ report: ValidationReport }>> {
	const storeId = storeIdOf(raw);
	const existing = storeId ? (await loadStore(env, storeId)).store : null;
	if (storeId && !existing) return fail(404, "Store not found");
	const parsed = parseStoreInput(raw, existing);
	if (!parsed.ok) return fail(400, parsed.error, parsed.field ? { field: parsed.field } : {});
	const input = parsed.value;
	let credentials = input.credentials;
	if (!credentials && existing) {
		try {
			credentials = await openStoreCredentials(env, existing);
		} catch {
			return fail(409, "The saved credentials cannot be opened; enter the key pair again");
		}
	}
	if (!credentials) return fail(400, "Enter the access key ID and the secret");
	const report = await validateStore(env, { ...input, credentials }, requestOrigin);
	await createAuditLog(env, {
		actorUserId: actor.id,
		action: "storage.store_tested",
		metadata: { ...auditMetadata(storeId, input), ok: report.ok, cors: report.cors },
	});
	return { ok: true, report };
}

const environmentChecks = new Map<string, number>();

export async function recordCheck(env: StoresEnv, store: StoreRecord, report: ValidationReport): Promise<void> {
	if (store.source === "environment") {
		if (report.ok) environmentChecks.set(store.id, Date.now());
		else environmentChecks.delete(store.id);
		return;
	}
	await getDb(env)
		.update(storageStores)
		.set({ status: report.ok ? "ok" : "error", lastCheckedAt: new Date(), lastError: reportSummary(report) })
		.where(eq(storageStores.id, store.id));
	clearStorageConfigCache();
}

export function checkedRecently(store: StoreRecord, now = Date.now()): boolean {
	const at = store.source === "environment" ? environmentChecks.get(store.id) : store.lastCheckedAt?.getTime();
	return store.status !== "error" && !!at && now - at < VALIDATION_FRESH_MS;
}

/** Sets the CORS rule on providers whose own keys may (PutBucketCors), then checks it from the browser's side. */
export async function applyStoreCors(
	env: StoresEnv,
	id: string,
	requestOrigin: string,
): Promise<Result<{ steps: ValidationStep[]; cors: boolean }>> {
	const { store } = await loadStore(env, id);
	if (!store) return fail(404, "Store not found");
	if (store.blocked) return fail(409, store.blocked);
	const origins = originsFor(env, requestOrigin);
	if (!presetFor(store.provider)?.applyCors)
		return fail(409, `Add this CORS rule in the provider's console: ${corsRuleJson(origins)}`);
	let candidate;
	try {
		candidate = await candidateOf(env, store);
	} catch {
		return fail(409, "The saved credentials cannot be opened; APP_ENCRYPTION_KEY may have changed");
	}
	try {
		await new S3Bucket({ ...candidate.location, ...candidate.credentials }).putCors(origins);
	} catch (error) {
		return fail(502, error instanceof Error ? error.message : "The provider refused the CORS rule");
	}
	const check = await validateStoreCors(candidate, requestOrigin);
	return { ok: true, steps: check.steps, cors: check.ok };
}

/** Adds the abort-incomplete-uploads rule, only to a bucket without lifecycle rules, so none is overwritten. */
export async function applyStoreLifecycle(env: StoresEnv, id: string): Promise<Result<object>> {
	const { store } = await loadStore(env, id);
	if (!store) return fail(404, "Store not found");
	if (store.blocked) return fail(409, store.blocked);
	if (!presetFor(store.provider)?.applyLifecycle) return fail(409, "Add the lifecycle rule in the provider's console");
	let candidate;
	try {
		candidate = await candidateOf(env, store);
	} catch {
		return fail(409, "The saved credentials cannot be opened; APP_ENCRYPTION_KEY may have changed");
	}
	try {
		const bucket = new S3Bucket({ ...candidate.location, ...candidate.credentials });
		if (await bucket.getLifecycle())
			return fail(409, "The bucket already has lifecycle rules; add the abort rule next to them by hand");
		await bucket.putAbortIncompleteUploadsLifecycle(7);
	} catch (error) {
		return fail(502, error instanceof Error ? error.message : "The provider refused the lifecycle rule");
	}
	return { ok: true };
}
