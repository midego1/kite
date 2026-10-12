import { cache } from "react";
import { eq } from "drizzle-orm";
import { createDb } from "@/db";
import { moduleSettings, userModuleAccess } from "@/db/schema/modules";
import type { ModuleId } from "./module-types";
import { MODULE_IDS, MODULE_MANIFESTS } from "./registry";
import type { ModuleFlagRow, ModuleFlags, ModuleViewer } from "./state-types";
import { effectiveModules, flagsFromRows, isNoSuchTableError } from "./state-utils";

type Binding = CloudflareEnv["DB"];
type StateEnv = Pick<CloudflareEnv, "DB">;
type Timed<T> = { at: number; value: Promise<T> };
type IsolateEntry = { install?: Timed<ModuleFlags>; access: Map<string, Timed<ModuleFlags>> };

/** A toggle reaches other isolates within this time; the admin page says so. */
const CACHE_TTL_MS = 30_000;
const MAX_CACHED_USERS = 500;

let isolateCache = new WeakMap<object, IsolateEntry>();
/** Part of the per-request memo key, so a write earlier in the same request is not hidden by the memo. */
let generation = 0;

function entryFor(db: Binding): IsolateEntry {
	let entry = isolateCache.get(db);
	if (!entry) isolateCache.set(db, (entry = { access: new Map() }));
	return entry;
}

function fresh<T>(timed: Timed<T> | undefined): timed is Timed<T> {
	return !!timed && Date.now() - timed.at < CACHE_TTL_MS;
}

/** Caches the promise so concurrent first reads share one query, and drops it again if the query fails. */
function remember<T>(load: () => Promise<T>, store: (timed: Timed<T> | undefined) => void): Promise<T> {
	const timed = { at: Date.now(), value: load() };
	store(timed);
	timed.value.catch(() => store(undefined));
	return timed.value;
}

type ManifestFallback = Parameters<typeof flagsFromRows>[2];
const installFallback: ManifestFallback = (manifest) => manifest.defaultEnabled;
const accessFallback: ManifestFallback = () => true;

type StoredFlags = { ready: boolean; flags: ModuleFlags };

/** A missing table means the database has not applied migration 0062 yet, which reads as every module on. */
async function readStored(read: () => Promise<ModuleFlagRow[]>, fallback: ManifestFallback): Promise<StoredFlags> {
	try {
		return { ready: true, flags: flagsFromRows(await read(), MODULE_MANIFESTS, fallback) };
	} catch (error) {
		if (!isNoSuchTableError(error)) throw error;
		return { ready: false, flags: flagsFromRows([], MODULE_MANIFESTS, fallback) };
	}
}

async function readFlags(read: () => Promise<ModuleFlagRow[]>, fallback: ManifestFallback): Promise<ModuleFlags> {
	return (await readStored(read, fallback)).flags;
}

const installRows = (db: Binding) =>
	createDb(db).select({ moduleId: moduleSettings.moduleId, flag: moduleSettings.enabled }).from(moduleSettings);

const accessRows = (db: Binding, userId: string) =>
	createDb(db)
		.select({ moduleId: userModuleAccess.moduleId, flag: userModuleAccess.allowed })
		.from(userModuleAccess)
		.where(eq(userModuleAccess.userId, userId));

function loadInstall(db: Binding): Promise<ModuleFlags> {
	return readFlags(() => installRows(db), installFallback);
}

function loadAccess(db: Binding, userId: string): Promise<ModuleFlags> {
	return readFlags(() => accessRows(db, userId), accessFallback);
}

function installFromIsolate(db: Binding): Promise<ModuleFlags> {
	const entry = entryFor(db);
	if (fresh(entry.install)) return entry.install.value;
	return remember(
		() => loadInstall(db),
		(timed) => (entry.install = timed),
	);
}

function accessFromIsolate(db: Binding, userId: string): Promise<ModuleFlags> {
	const entry = entryFor(db);
	const cached = entry.access.get(userId);
	if (fresh(cached)) return cached.value;
	if (entry.access.size >= MAX_CACHED_USERS) entry.access.clear();
	return remember(
		() => loadAccess(db, userId),
		(timed) => (timed ? entry.access.set(userId, timed) : entry.access.delete(userId)),
	);
}

// React's `cache` memoizes per server request, so a page that asks many times reads at most once.
const installForRequest = cache((db: Binding, _generation: number) => installFromIsolate(db));
const accessForRequest = cache((db: Binding, userId: string, _generation: number) => accessFromIsolate(db, userId));

/**
 * The install switch of every module: stored flag, or `defaultEnabled` with no row or no table. Dependencies are not applied.
 */
export function getInstallModuleState(env: StateEnv): Promise<ModuleFlags> {
	return installForRequest(env.DB, generation);
}

/**
 * What a user may use: no row means allowed, and the primary admin is always allowed.
 */
export async function getUserModuleAccess(
	env: StateEnv,
	viewer: Pick<ModuleViewer, "userId" | "isPrimaryAdmin">,
): Promise<ModuleFlags> {
	if (viewer.isPrimaryAdmin) return new Map(MODULE_IDS.map((id) => [id, true]));
	return accessForRequest(env.DB, viewer.userId, generation);
}

async function effectiveFor(env: StateEnv, viewer: ModuleViewer | null): Promise<Set<ModuleId>> {
	const [install, access] = await Promise.all([
		getInstallModuleState(env),
		viewer ? getUserModuleAccess(env, viewer) : Promise.resolve(new Map<ModuleId, boolean>()),
	]);
	return effectiveModules(install, access, MODULE_MANIFESTS);
}

/**
 * Install level and dependencies only, for callers with no viewer (cron, queue, webhook retries).
 */
export async function isModuleEnabled(env: StateEnv, id: ModuleId): Promise<boolean> {
	return (await effectiveFor(env, null)).has(id);
}

/**
 * Install level, dependencies and the viewer's own access.
 */
export async function isModuleEnabledFor(env: StateEnv, viewer: ModuleViewer, id: ModuleId): Promise<boolean> {
	return (await effectiveFor(env, viewer)).has(id);
}

/** The modules a viewer can use, in registry order. */
export async function listEnabledModules(env: StateEnv, viewer: ModuleViewer | null): Promise<ModuleId[]> {
	const enabled = await effectiveFor(env, viewer);
	return MODULE_IDS.filter((id) => enabled.has(id));
}

/**
 * The install flags as stored, bypassing every cache, and whether migration 0062 is applied.
 */
export function readStoredInstallState(env: StateEnv): Promise<StoredFlags> {
	return readStored(() => installRows(env.DB), installFallback);
}

/**
 * One user's stored access flags, bypassing every cache.
 */
export function readStoredUserAccess(env: StateEnv, userId: string): Promise<StoredFlags> {
	return readStored(() => accessRows(env.DB, userId), accessFallback);
}

/**
 * Drops every cached answer in this isolate. Writes call it, so the isolate that handled one sees it at
 * once, and so does a backup restore, which rewrites both tables behind the cache.
 */
export function clearModuleStateCache(): void {
	isolateCache = new WeakMap();
	generation++;
}

/**
 * Turns a module on or off for the install.
 */
export async function setModuleEnabled(
	env: StateEnv,
	input: { moduleId: ModuleId; enabled: boolean; updatedBy: string | null },
): Promise<void> {
	const set = { enabled: input.enabled, updatedAt: new Date(), updatedBy: input.updatedBy };
	try {
		await createDb(env.DB)
			.insert(moduleSettings)
			.values({ id: input.moduleId, moduleId: input.moduleId, ...set })
			.onConflictDoUpdate({ target: moduleSettings.moduleId, set });
	} finally {
		clearModuleStateCache();
	}
}

/**
 * Allows or restricts one module for one user.
 */
export async function setUserModuleAllowed(
	env: StateEnv,
	input: { userId: string; moduleId: ModuleId; allowed: boolean; updatedBy: string | null },
): Promise<void> {
	const set = { allowed: input.allowed, updatedAt: new Date(), updatedBy: input.updatedBy };
	try {
		await createDb(env.DB)
			.insert(userModuleAccess)
			.values({ id: crypto.randomUUID(), userId: input.userId, moduleId: input.moduleId, ...set })
			.onConflictDoUpdate({ target: [userModuleAccess.userId, userModuleAccess.moduleId], set });
	} finally {
		clearModuleStateCache();
	}
}
