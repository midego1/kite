import { and, asc, desc, eq, ne, type SQL } from "drizzle-orm";
import { getDb } from "@/db";
import { appSettings } from "@/db/schema";
import { agentProviders } from "@/db/schema/agent-providers";
import { newId } from "@/lib/ids";
import { isNoSuchTableError } from "@/lib/modules/state-utils";
import { openSetting } from "@/lib/security/secret-box";
import { AGENT_SETTINGS_ID } from "./provider-constants";
import type { AgentProviderConnection, AgentProviderKind, AgentProviderPreset } from "./provider-types";
import {
	defaultAgentProviderName,
	publicAgentProvider,
	sortAgentProviders,
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

async function withKey(env: CloudflareEnv, stored: StoredAgentProvider): Promise<StoredAgentProvider> {
	return { ...stored, apiKey: await openSetting(env, stored.apiKey) };
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
 * The provider in use with its key opened: the active saved provider, else (before migration 0077, or while no
 * provider is saved, as after restoring an older backup) the legacy `app_settings` columns. Null means nothing is
 * saved and the environment decides.
 */
export async function readStoredAgentProvider(env: CloudflareEnv): Promise<StoredAgentProvider | null> {
	try {
		const [row] = await getDb(env)
			.select(rowColumns)
			.from(agentProviders)
			.orderBy(desc(agentProviders.active), asc(agentProviders.createdAt))
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
	return rows[0] ? { ...rows[0], apiKey: await openSetting(env, rows[0].apiKey) } : null;
}

async function selectRows(env: CloudflareEnv, where?: SQL): Promise<StoredAgentProviderRow[]> {
	try {
		const query = getDb(env).select(rowColumns).from(agentProviders);
		return await (where ? query.where(where) : query);
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
		return { ready: true, providers: sortAgentProviders(await selectRows(env)).map(publicAgentProvider) };
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

/** Adds a provider; it becomes active when asked to or when it is the first one. Returns its id. */
export async function createAgentProvider(
	env: CloudflareEnv,
	values: AgentProviderValues,
	options: { activate?: boolean } = {},
): Promise<string> {
	const db = getDb(env);
	const activate = options.activate || !(await activeAgentProviderId(env));
	const id = newId("aip");
	const now = new Date();
	const name = values.name ?? defaultAgentProviderName(values.provider, values.preset);
	const insert = db
		.insert(agentProviders)
		.values({ id, ...values, name, active: activate, createdAt: now, updatedAt: now });
	if (!activate) await insert;
	else
		await db.batch([
			db.update(agentProviders).set({ active: false, updatedAt: now }).where(eq(agentProviders.active, true)),
			insert,
		]);
	return id;
}

/** Saves a provider's settings; without a name a default name follows a change of provider, a typed one stays. */
export async function updateAgentProvider(env: CloudflareEnv, id: string, values: AgentProviderValues): Promise<void> {
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
}

/**
 * Makes `id` the provider in use, in one batch so exactly one row stays active. Returns the names for the audit
 * log (`previous` is null when nothing was active), or null when `id` already was.
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
	const db = getDb(env);
	const now = new Date();
	await db.batch([
		db
			.update(agentProviders)
			.set({ active: false, updatedAt: now })
			.where(and(eq(agentProviders.active, true), ne(agentProviders.id, id))),
		db.update(agentProviders).set({ active: true, updatedAt: now }).where(eq(agentProviders.id, id)),
	]);
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
	return { name: row.name };
}
