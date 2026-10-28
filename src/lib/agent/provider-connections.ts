import { and, asc, eq, sql, type SQL } from "drizzle-orm";
import { getDb } from "@/db";
import { appSettings } from "@/db/schema";
import { agentProviders } from "@/db/schema/agent-providers";
import { newId } from "@/lib/ids";
import { isNoSuchTableError } from "@/lib/modules/state-utils";
import { openSetting, SecretBoxError } from "@/lib/security/secret-box";
import { AGENT_SETTINGS_ID } from "./provider-constants";
import type { AgentProviderConnection, AgentProviderKind, AgentProviderPreset } from "./provider-types";
import {
	defaultAgentProviderName,
	environmentKeyApplies,
	publicAgentProvider,
	type StoredAgentProvider,
	type StoredAgentProviderRow,
} from "./provider-connection-utils";

/** Saved providers need migration 0077; until it is applied only the one legacy provider can be saved. */
export class AgentProvidersPendingError extends Error {
	constructor() {
		super("Apply the pending database update to save more than one AI provider");
		this.name = "AgentProvidersPendingError";
	}
}

export class AgentProviderNotFoundError extends Error {
	constructor() {
		super("AI provider not found");
		this.name = "AgentProviderNotFoundError";
	}
}

/** A request was about to use a provider whose saved key cannot be opened; classified as `provider_key_unreadable`. */
export class AgentProviderKeyUnreadableError extends Error {
	constructor() {
		super("The AI provider's saved API key can't be read; enter it again in Admin → Agent");
		this.name = "AgentProviderKeyUnreadableError";
	}
}

export class ActiveAgentProviderError extends Error {
	constructor() {
		super("Switch to another provider before deleting the one in use");
		this.name = "ActiveAgentProviderError";
	}
}

/** Everything a provider save writes, the key already sealed. */
export type AgentProviderValues = {
	/** Undefined keeps the stored name (or gives a new provider its default name). */
	name?: string;
	provider: AgentProviderKind;
	preset: AgentProviderPreset | null;
	baseUrl: string | null;
	apiKey: string | null;
	model: string;
	modelRates: string;
};

const rowColumns = {
	id: agentProviders.id,
	name: agentProviders.name,
	provider: agentProviders.provider,
	preset: agentProviders.preset,
	baseUrl: agentProviders.baseUrl,
	apiKey: agentProviders.apiKey,
	model: agentProviders.model,
	rates: agentProviders.modelRates,
	active: agentProviders.active,
	createdAt: agentProviders.createdAt,
};

/**
 * Opens a stored key. A key sealed under another APP_ENCRYPTION_KEY (a restore into another install, a rotated key)
 * reads as missing and `keyUnreadable`, so the admin page and switching keep working and AI calls say why they fail.
 */
async function openKey(
	env: CloudflareEnv,
	stored: string | null,
): Promise<{ apiKey: string | null; keyUnreadable: boolean }> {
	try {
		return { apiKey: await openSetting(env, stored), keyUnreadable: false };
	} catch (error) {
		if (error instanceof SecretBoxError) return { apiKey: null, keyUnreadable: true };
		throw error;
	}
}

async function withKey<T extends StoredAgentProvider>(env: CloudflareEnv, stored: T): Promise<T> {
	return { ...stored, ...(await openKey(env, stored.apiKey)) };
}

/** The provider saved before migration 0077, in `app_settings`; also what an empty `agent_providers` falls back to. */
async function readLegacyAgentProvider(env: CloudflareEnv): Promise<StoredAgentProvider | null> {
	const [saved] = await getDb(env)
		.select({
			provider: appSettings.agentProvider,
			preset: appSettings.agentPreset,
			baseUrl: appSettings.agentBaseUrl,
			apiKey: appSettings.agentApiKey,
			model: appSettings.agentModel,
			rates: appSettings.agentModelRates,
		})
		.from(appSettings)
		.where(eq(appSettings.id, AGENT_SETTINGS_ID))
		.limit(1);
	return saved ? withKey(env, saved) : null;
}

/**
 * The provider in use with its key opened: the active saved provider, else (before migration 0077, or while none is
 * active, as after restoring an older backup) the legacy `app_settings` columns. Null means nothing is saved and the
 * environment decides.
 */
export async function readStoredAgentProvider(env: CloudflareEnv): Promise<StoredAgentProvider | null> {
	try {
		const [row] = await getDb(env)
			.select(rowColumns)
			.from(agentProviders)
			.where(eq(agentProviders.active, true))
			.limit(1);
		if (row) return withKey(env, row);
	} catch (error) {
		if (!isNoSuchTableError(error)) throw error;
	}
	return readLegacyAgentProvider(env);
}

/** One saved provider with its key opened, or null when there is no such row. Throws before migration 0077. */
export async function readSavedAgentProvider(env: CloudflareEnv, id: string): Promise<StoredAgentProviderRow | null> {
	const rows = await selectRows(env, eq(agentProviders.id, id));
	return rows[0] ? withKey(env, rows[0]) : null;
}

async function selectRows(env: CloudflareEnv, where?: SQL, order: SQL[] = []): Promise<StoredAgentProviderRow[]> {
	try {
		return await getDb(env)
			.select(rowColumns)
			.from(agentProviders)
			.where(where)
			.orderBy(...order);
	} catch (error) {
		if (isNoSuchTableError(error)) throw new AgentProvidersPendingError();
		throw error;
	}
}

/** The saved providers for the admin page, without keys; `ready` is false before migration 0077. */
export async function listAgentProviders(
	env: CloudflareEnv,
): Promise<{ ready: boolean; providers: AgentProviderConnection[] }> {
	try {
		// In the order they were added; rowid breaks a tie within the same millisecond.
		const rows = await selectRows(env, undefined, [asc(agentProviders.createdAt), sql`rowid`]);
		return {
			ready: true,
			providers: await Promise.all(
				rows.map(async (row) => {
					const { keyUnreadable } = await openKey(env, row.apiKey);
					return publicAgentProvider(row, { keyUnreadable, environmentKey: environmentKeyApplies(env, row) });
				}),
			),
		};
	} catch (error) {
		if (error instanceof AgentProvidersPendingError) return { ready: false, providers: [] };
		throw error;
	}
}

/** The active row's id, or null when no provider is saved yet. */
export async function activeAgentProviderId(env: CloudflareEnv): Promise<string | null> {
	const [row] = await selectRows(env, eq(agentProviders.active, true));
	return row?.id ?? null;
}

/** Before migration 0077 the one provider lives in `app_settings`, as it always did. */
export async function saveLegacyAgentProvider(env: CloudflareEnv, values: AgentProviderValues): Promise<void> {
	const set = {
		agentProvider: values.provider,
		agentPreset: values.preset,
		agentBaseUrl: values.baseUrl,
		agentApiKey: values.apiKey,
		agentModel: values.model,
		agentModelRates: values.modelRates,
		updatedAt: new Date(),
	};
	await getDb(env)
		.insert(appSettings)
		.values({ id: AGENT_SETTINGS_ID, ...set })
		.onConflictDoUpdate({ target: appSettings.id, set });
}

/** Turns `id` on and every other row off in one statement; it changes nothing when `id` does not exist. */
const ACTIVATE_SQL =
	"UPDATE agent_providers SET active = (id = ?), updated_at = CASE WHEN active <> (id = ?) THEN ? ELSE updated_at END WHERE EXISTS (SELECT 1 FROM agent_providers WHERE id = ?)";
/**
 * Once a saved provider is in use, the legacy single provider (key included) is cleared, so a deleted provider's key
 * is gone and backups carry no stale copy. Before 0077, or while none is active, the legacy columns stay the source.
 */
const CLEAR_LEGACY_SQL =
	"UPDATE app_settings SET agent_provider = NULL, agent_preset = NULL, agent_base_url = NULL, agent_api_key = NULL, agent_model = NULL, agent_model_rates = NULL WHERE id = ? AND EXISTS (SELECT 1 FROM agent_providers WHERE active = 1)";

function activateStatement(env: CloudflareEnv, id: string) {
	return env.DB.prepare(ACTIVATE_SQL).bind(id, id, Date.now(), id);
}

function clearLegacyStatement(env: CloudflareEnv) {
	return env.DB.prepare(CLEAR_LEGACY_SQL).bind(AGENT_SETTINGS_ID);
}

/** Adds a provider, in use only when `activate` is set. Returns its id. */
export async function createAgentProvider(
	env: CloudflareEnv,
	values: AgentProviderValues,
	options: { activate?: boolean } = {},
): Promise<string> {
	const id = newId("aip");
	const now = Date.now();
	const name = values.name ?? defaultAgentProviderName(values.provider, values.preset);
	const insert = env.DB.prepare(
		"INSERT INTO agent_providers (id, name, provider, preset, base_url, api_key, model, model_rates, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)",
	).bind(
		id,
		name,
		values.provider,
		values.preset,
		values.baseUrl,
		values.apiKey,
		values.model,
		values.modelRates,
		now,
		now,
	);
	try {
		await env.DB.batch(options.activate ? [insert, activateStatement(env, id), clearLegacyStatement(env)] : [insert]);
	} catch (error) {
		if (isNoSuchTableError(error)) throw new AgentProvidersPendingError();
		throw error;
	}
	return id;
}

/** Saves a provider's settings; without a name a default name follows a change of provider, a typed one stays. */
export async function updateAgentProvider(
	env: CloudflareEnv,
	id: string,
	values: AgentProviderValues,
): Promise<{ name: string; active: boolean }> {
	const [row] = await selectRows(env, eq(agentProviders.id, id));
	if (!row) throw new AgentProviderNotFoundError();
	const name =
		values.name ??
		(row.name === defaultAgentProviderName(row.provider, row.preset)
			? defaultAgentProviderName(values.provider, values.preset)
			: row.name);
	await getDb(env)
		.update(agentProviders)
		.set({ ...values, name, updatedAt: new Date() })
		.where(eq(agentProviders.id, id));
	await clearLegacyStatement(env).run();
	return { name, active: row.active };
}

/**
 * Makes `id` the provider in use with one statement, so exactly one row is active afterwards. Returns the names for
 * the audit log (`previous` is null when nothing was active), or null when `id` already was.
 */
export async function activateAgentProvider(
	env: CloudflareEnv,
	id: string,
): Promise<{ name: string; previous: string | null } | null> {
	const rows = await selectRows(env);
	const target = rows.find((row) => row.id === id);
	if (!target) throw new AgentProviderNotFoundError();
	if (target.active) return null;
	const previous = rows.find((row) => row.active)?.name ?? null;
	const [activated] = await env.DB.batch([activateStatement(env, id), clearLegacyStatement(env)]);
	// Deleted between the read and the update: the statement matched nothing and nothing changed.
	if (!activated?.meta.changes) throw new AgentProviderNotFoundError();
	return { name: target.name, previous };
}

/** Deletes an inactive provider and its key; the active one is refused so a provider always stays in use. */
export async function deleteAgentProvider(env: CloudflareEnv, id: string): Promise<{ name: string }> {
	const [row] = await selectRows(env, eq(agentProviders.id, id));
	if (!row) throw new AgentProviderNotFoundError();
	if (row.active) throw new ActiveAgentProviderError();
	await getDb(env)
		.delete(agentProviders)
		.where(and(eq(agentProviders.id, id), eq(agentProviders.active, false)));
	// The provider migration 0077 copied may still have its key in the legacy columns; deleting it removes that too.
	await clearLegacyStatement(env).run();
	return { name: row.name };
}
