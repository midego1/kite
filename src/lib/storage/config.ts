import { createLogger } from "@/lib/logger.mjs";
import { isNoSuchTableError } from "@/lib/modules/state-utils";
import { assertPublicHttpUrl } from "@/lib/security/outbound-url";
import { openSetting } from "@/lib/security/secret-box";
import {
	EMPTY_STORAGE_CONFIG,
	environmentClasses,
	environmentStore,
	mergeEnvironmentRoutes,
	parseCredentials,
	routeRecordFromRow,
	storeRecordFromRow,
	type RouteRecord,
	type RouteRow,
	type StorageConfig,
	type StoreRecord,
	type StoreRow,
} from "./config-utils";
import {
	endpointHostname,
	endpointProblem,
	isAllowedLocalEndpoint,
	storageEndpointPolicy,
	type EndpointPolicy,
} from "./endpoint-utils";
import type { RoutableClass, S3Credentials, S3Location } from "./types";

const log = createLogger("storage");

/**
 * A saved change reaches other isolates within this time; the admin page says so.
 * @public Exercised by the unit tests.
 */
export const CONFIG_TTL_MS = 30_000;
/** After a failed read with nothing cached, the next request tries again this soon. */
const FAILURE_RETRY_MS = 5_000;

export type StorageEnv = Pick<CloudflareEnv, "DB"> &
	Partial<
		Pick<
			CloudflareEnv,
			| "APP_ENCRYPTION_KEY"
			| "RESOLVE_HOST"
			| "KITE_RUNTIME"
			| "STORAGE_ALLOW_INSECURE_ENDPOINT"
			| "STORAGE_ALLOW_PRIVATE_ENDPOINTS"
			| "STORAGE_S3_ENDPOINT"
			| "STORAGE_S3_REGION"
			| "STORAGE_S3_BUCKET"
			| "STORAGE_S3_ACCESS_KEY_ID"
			| "STORAGE_S3_SECRET_ACCESS_KEY"
			| "STORAGE_S3_ADDRESSING"
			| "STORAGE_S3_CLASSES"
		>
	>;

type Entry = { at: number; ttl: number; value: Promise<StorageConfig>; known?: StorageConfig };
type SharedCache = { entries: WeakMap<object, Entry> };

const SHARED_CACHE_KEY = Symbol.for("kite.storage.config-cache");

/** On `globalThis` because the Node build loads this file once for route handlers and again for pages. */
function sharedCache(): SharedCache {
	const holder = globalThis as { [SHARED_CACHE_KEY]?: SharedCache };
	return (holder[SHARED_CACHE_KEY] ??= { entries: new WeakMap() });
}

export function endpointPolicyFor(env: StorageEnv): EndpointPolicy {
	return storageEndpointPolicy(env, process.env.NODE_ENV);
}

class StorageEndpointError extends Error {}

/**
 * The endpoint guard: the literal check under the dev flags, then, on the Node server, every address the host
 * resolves to. It runs before a store is saved and again each time the config is loaded, so a host that starts
 * resolving to a private address is refused without anyone editing the store.
 */
export async function assertStoreEndpoint(
	env: StorageEnv,
	location: Pick<S3Location, "endpoint" | "scheme">,
): Promise<void> {
	const policy = endpointPolicyFor(env);
	const problem = endpointProblem(location, policy);
	if (problem) throw new StorageEndpointError(problem);
	if (isAllowedLocalEndpoint(location, policy)) return;
	const host = endpointHostname(location.endpoint);
	try {
		await assertPublicHttpUrl(env, `https://${host.includes(":") ? `[${host}]` : host}/`);
	} catch (error) {
		throw new StorageEndpointError(error instanceof Error ? error.message : "The endpoint is not allowed");
	}
}

async function guardStore(env: StorageEnv, store: StoreRecord): Promise<StoreRecord> {
	try {
		await assertStoreEndpoint(env, store.location);
		return store;
	} catch (error) {
		const blocked = error instanceof Error ? error.message : "The endpoint is not allowed";
		log.warn("storage.store_blocked", { storeId: store.id, reason: blocked });
		return { ...store, blocked };
	}
}

async function readRows(env: StorageEnv): Promise<{ stores: StoreRow[]; routes: RouteRow[] }> {
	try {
		const [stores, routes] = await env.DB.batch([
			env.DB.prepare("SELECT * FROM storage_stores ORDER BY created_at, id"),
			env.DB.prepare("SELECT object_class, store_id, previous_store_id FROM storage_routes"),
		]);
		return { stores: (stores.results ?? []) as StoreRow[], routes: (routes.results ?? []) as RouteRow[] };
	} catch (error) {
		// Before migration 0065 every class is on the default store.
		if (isNoSuchTableError(error)) return { stores: [], routes: [] };
		throw error;
	}
}

const STORAGE_TABLES = ["storage_stores", "storage_routes", "storage_migrations"];
/** Migrations only add tables, so once they exist the check is skipped for the rest of the isolate's life. */
const readyDatabases = new WeakSet<object>();

/** Whether migration 0065 has been applied; reads only `sqlite_master`. */
export async function storageTablesReady(env: Pick<CloudflareEnv, "DB">): Promise<boolean> {
	if (readyDatabases.has(env.DB)) return true;
	const row = await env.DB.prepare(
		`SELECT count(*) AS present FROM sqlite_master WHERE type = 'table' AND name IN (${STORAGE_TABLES.map(() => "?").join(", ")})`,
	)
		.bind(...STORAGE_TABLES)
		.first<{ present: number }>();
	const ready = Number(row?.present ?? 0) === STORAGE_TABLES.length;
	if (ready) readyDatabases.add(env.DB);
	return ready;
}

/** Reads and guards the config, bypassing the cache. */
export async function readStorageConfig(env: StorageEnv): Promise<StorageConfig> {
	const rows = await readRows(env);
	const stores = new Map<string, StoreRecord>();
	const records = rows.stores.map(storeRecordFromRow).filter((store): store is StoreRecord => !!store);
	const fromEnvironment = environmentStore(env);
	if (fromEnvironment) records.push(fromEnvironment);
	for (const store of await Promise.all(records.map((record) => guardStore(env, record)))) stores.set(store.id, store);
	const routes = new Map<RoutableClass, RouteRecord>();
	for (const route of rows.routes.map(routeRecordFromRow)) if (route) routes.set(route.objectClass, route);
	if (fromEnvironment) mergeEnvironmentRoutes(routes, environmentClasses(env.STORAGE_S3_CLASSES));
	return { stores, routes };
}

/**
 * The storage config, cached for 30 s per isolate (one batched D1 read). When a read fails the last config this
 * isolate saw is used; with none, every class is on the default store, so inbound mail is never bounced by a
 * transient D1 error.
 */
export function loadStorageConfig(env: StorageEnv): Promise<StorageConfig> {
	const { entries } = sharedCache();
	const entry = entries.get(env.DB);
	if (entry && Date.now() - entry.at < entry.ttl) return entry.value;
	const next: Entry = {
		at: Date.now(),
		ttl: CONFIG_TTL_MS,
		value: Promise.resolve(EMPTY_STORAGE_CONFIG),
		known: entry?.known,
	};
	next.value = readStorageConfig(env).then(
		(config) => {
			next.known = config;
			return config;
		},
		(error: unknown) => {
			if (next.known) {
				log.warn("storage.config_stale", { error });
				return next.known;
			}
			log.error("storage.config_unavailable", { error });
			next.ttl = FAILURE_RETRY_MS;
			return EMPTY_STORAGE_CONFIG;
		},
	);
	entries.set(env.DB, next);
	return next.value;
}

/** Drops the cached config in this isolate; every write to the storage tables calls it. */
export function clearStorageConfigCache(): void {
	sharedCache().entries = new WeakMap();
	openedCredentials.clear();
}

const openedCredentials = new Map<string, Promise<S3Credentials>>();

/** Opens a store's sealed credentials once per config; they are only ever held in memory. */
export function openStoreCredentials(env: StorageEnv, store: StoreRecord): Promise<S3Credentials> {
	if (store.plainCredentials) return Promise.resolve(store.plainCredentials);
	const cacheKey = `${store.id}:${store.updatedAt?.getTime() ?? 0}`;
	let opened = openedCredentials.get(cacheKey);
	if (!opened) {
		opened = openSetting(env, store.sealedCredentials).then(parseCredentials);
		openedCredentials.set(cacheKey, opened);
		opened.catch(() => openedCredentials.delete(cacheKey));
	}
	return opened;
}
