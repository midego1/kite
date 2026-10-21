import { parseStoredEndpoint } from "./endpoint-utils";
import { isS3Provider } from "./s3-presets-utils";
import type { ObjectClass, RoutableClass, S3Addressing, S3Credentials, S3Location, S3Provider } from "./types";

export const DEFAULT_STORE_ID = "default";
/** The read-only store `STORAGE_S3_*` describes; it has no database row. */
export const ENVIRONMENT_STORE_ID = "sto_env";
export const ROUTABLE_CLASSES: readonly RoutableClass[] = ["mail", "drive", "backups"];

export type StoreStatus = "ok" | "error" | "unchecked";

export type StoreRecord = {
	id: string;
	name: string;
	provider: S3Provider;
	location: S3Location;
	/** Sealed JSON `{ accessKeyId, secretAccessKey }`, opened only when the store is used. */
	sealedCredentials: string;
	/** Credentials from the environment for the `STORAGE_S3_*` store; never set for a database row. */
	plainCredentials?: S3Credentials;
	/** R2 S3 API keys for the `BUCKET` binding, used only to sign browser URLs for the default store. */
	sameAsBinding: boolean;
	status: StoreStatus;
	lastCheckedAt: Date | null;
	lastError: string | null;
	createdAt: Date | null;
	updatedAt: Date | null;
	source: "database" | "environment";
	/** Why the endpoint guard refuses this store under the current flags; a blocked store is never contacted. */
	blocked: string | null;
};

export type RouteRecord = { objectClass: RoutableClass; storeId: string; previousStoreId: string | null };

export type StorageConfig = {
	stores: ReadonlyMap<string, StoreRecord>;
	routes: ReadonlyMap<RoutableClass, RouteRecord>;
};

export const EMPTY_STORAGE_CONFIG: StorageConfig = { stores: new Map(), routes: new Map() };

export type StoreRow = {
	id: string;
	name: string;
	provider: string;
	endpoint: string;
	region: string;
	bucket: string;
	addressing: string;
	credentials: string;
	same_as_binding: number | boolean;
	status: string;
	last_checked_at: number | null;
	last_error: string | null;
	created_at: number | null;
	updated_at: number | null;
};

export type RouteRow = { object_class: string; store_id: string; previous_store_id: string | null };

/** Drizzle's `mode: "timestamp"` columns hold seconds. */
const fromSeconds = (value: number | null) => (value == null ? null : new Date(Number(value) * 1000));

export function isRoutableClass(value: unknown): value is RoutableClass {
	return typeof value === "string" && (ROUTABLE_CLASSES as readonly string[]).includes(value);
}

export function storeRecordFromRow(row: StoreRow): StoreRecord | null {
	if (!isS3Provider(row.provider)) return null;
	return {
		id: row.id,
		name: row.name,
		provider: row.provider,
		location: {
			...parseStoredEndpoint(row.endpoint),
			region: row.region,
			bucket: row.bucket,
			addressing: row.addressing === "path" ? "path" : "virtual",
		},
		sealedCredentials: row.credentials,
		sameAsBinding: !!row.same_as_binding,
		status: row.status === "ok" || row.status === "error" ? row.status : "unchecked",
		lastCheckedAt: fromSeconds(row.last_checked_at),
		lastError: row.last_error,
		createdAt: fromSeconds(row.created_at),
		updatedAt: fromSeconds(row.updated_at),
		source: "database",
		blocked: null,
	};
}

export function routeRecordFromRow(row: RouteRow): RouteRecord | null {
	if (!isRoutableClass(row.object_class)) return null;
	return { objectClass: row.object_class, storeId: row.store_id, previousStoreId: row.previous_store_id };
}

type EnvironmentVars = Partial<
	Pick<
		CloudflareEnv,
		| "STORAGE_S3_ENDPOINT"
		| "STORAGE_S3_REGION"
		| "STORAGE_S3_BUCKET"
		| "STORAGE_S3_ACCESS_KEY_ID"
		| "STORAGE_S3_SECRET_ACCESS_KEY"
		| "STORAGE_S3_ADDRESSING"
		| "STORAGE_S3_CLASSES"
	>
>;

/** The `STORAGE_S3_*` store, when all of its required variables are set. */
export function environmentStore(env: EnvironmentVars): StoreRecord | null {
	const endpoint = env.STORAGE_S3_ENDPOINT?.trim();
	const bucket = env.STORAGE_S3_BUCKET?.trim();
	const accessKeyId = env.STORAGE_S3_ACCESS_KEY_ID?.trim();
	const secretAccessKey = env.STORAGE_S3_SECRET_ACCESS_KEY?.trim();
	if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
	const withScheme = /^https?:\/\//i.test(endpoint) ? endpoint : `https://${endpoint}`;
	let url: URL;
	try {
		url = new URL(withScheme);
	} catch {
		return null;
	}
	const addressing: S3Addressing = env.STORAGE_S3_ADDRESSING?.trim() === "virtual" ? "virtual" : "path";
	return {
		id: ENVIRONMENT_STORE_ID,
		name: "Environment store",
		provider: "other",
		location: {
			endpoint: url.host.toLowerCase(),
			scheme: url.protocol === "http:" ? "http" : "https",
			region: env.STORAGE_S3_REGION?.trim() || "us-east-1",
			bucket,
			addressing,
		},
		sealedCredentials: "",
		plainCredentials: { accessKeyId, secretAccessKey },
		sameAsBinding: false,
		status: "unchecked",
		lastCheckedAt: null,
		lastError: null,
		createdAt: null,
		updatedAt: null,
		source: "environment",
		blocked: null,
	};
}

/** `STORAGE_S3_CLASSES=mail,drive` → the routable classes it names. */
export function environmentClasses(value: string | undefined): RoutableClass[] {
	return (value ?? "")
		.split(",")
		.map((part) => part.trim())
		.filter(isRoutableClass);
}

/** Saved routes win; the environment store takes only the classes no saved route names. */
export function mergeEnvironmentRoutes(
	routes: Map<RoutableClass, RouteRecord>,
	classes: readonly RoutableClass[],
): Map<RoutableClass, RouteRecord> {
	for (const objectClass of classes) {
		if (!routes.has(objectClass))
			routes.set(objectClass, { objectClass, storeId: ENVIRONMENT_STORE_ID, previousStoreId: null });
	}
	return routes;
}

/** The store new objects of a class go to; `system`, an unrouted class and an unusable store all mean default. */
export function activeStoreId(config: StorageConfig, objectClass: ObjectClass): string {
	if (objectClass === "system") return DEFAULT_STORE_ID;
	const storeId = config.routes.get(objectClass)?.storeId ?? DEFAULT_STORE_ID;
	return isUsableStore(config, storeId) ? storeId : DEFAULT_STORE_ID;
}

export function isUsableStore(config: StorageConfig, storeId: string | null | undefined): storeId is string {
	if (!storeId) return false;
	if (storeId === DEFAULT_STORE_ID) return true;
	const store = config.stores.get(storeId);
	return !!store && !store.blocked && !store.sameAsBinding;
}

/**
 * Where a read looks, in order: the active store, the previous one while a migration copies, then the default
 * store, which catches objects written while the config could not be read or by an isolate with a stale config.
 */
export function readChain(config: StorageConfig, objectClass: ObjectClass): string[] {
	if (objectClass === "system") return [DEFAULT_STORE_ID];
	const route = config.routes.get(objectClass);
	const chain = [route?.storeId, route?.previousStoreId, DEFAULT_STORE_ID].filter((id) => isUsableStore(config, id));
	return [...new Set(chain)];
}

/** A delete reaches the active and the previous store, so a migration cannot bring a deleted object back. */
export function deleteTargets(config: StorageConfig, objectClass: ObjectClass): string[] {
	if (objectClass === "system") return [DEFAULT_STORE_ID];
	const route = config.routes.get(objectClass);
	const targets = [route?.storeId ?? DEFAULT_STORE_ID, route?.previousStoreId].filter((id) =>
		isUsableStore(config, id),
	);
	return targets.length ? [...new Set(targets)] : [DEFAULT_STORE_ID];
}

/** The routes that name a store, as active or previous, so deleting it can be refused. */
export function routesUsingStore(config: StorageConfig, storeId: string): RoutableClass[] {
	return [...config.routes.values()]
		.filter((route) => route.storeId === storeId || route.previousStoreId === storeId)
		.map((route) => route.objectClass);
}

/** The last four characters of an access key id, the only part of a credential the API ever returns. */
export function keyHint(accessKeyId: string): string {
	return accessKeyId.length > 4 ? accessKeyId.slice(-4) : "";
}

/** Parses opened credentials; anything else means the sealed value is not ours. */
export function parseCredentials(value: string | null): S3Credentials {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value ?? "");
	} catch {
		throw new Error("The stored credentials are unreadable");
	}
	const { accessKeyId, secretAccessKey } = (parsed ?? {}) as Record<string, unknown>;
	if (typeof accessKeyId !== "string" || typeof secretAccessKey !== "string" || !accessKeyId || !secretAccessKey)
		throw new Error("The stored credentials are incomplete");
	return { accessKeyId, secretAccessKey };
}
