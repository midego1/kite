import { AGENT_SETTINGS_ID } from "@/lib/agent/provider-constants";
import { isNoSuchTableError } from "@/lib/modules/state-utils";
import { openSetting, sealSetting, SecretBoxError } from "@/lib/security/secret-box";

export type SemanticBackfillCursor = { createdAt: number; id: string };

export type SemanticInstallSettings = {
	enabled: boolean;
	embeddingProvider: "workers_ai" | "compatible" | null;
	compatibleBaseUrl: string | null;
	backfillCursor: SemanticBackfillCursor | null;
	backfillPaused: boolean;
	/** Percent (0-100) of the install's daily spend cap the backfill may use. */
	backfillCapShare: number;
};

const DEFAULT_SETTINGS: SemanticInstallSettings = {
	enabled: false,
	embeddingProvider: null,
	compatibleBaseUrl: null,
	backfillCursor: null,
	backfillPaused: false,
	backfillCapShare: 50,
};

type SemanticSettingsRow = {
	semanticSearchEnabled: number;
	semanticEmbeddingProvider: "workers_ai" | "compatible" | null;
	semanticCompatibleBaseUrl: string | null;
	semanticCompatibleApiKey: string | null;
	semanticBackfillCursor: string | null;
	semanticBackfillPaused: number;
	semanticBackfillCapShare: number;
};

/**
 * These seven columns are deliberately not mapped in the Drizzle `appSettings` schema (`src/db/schema/index.ts`),
 * so this is the only place that reads or writes them, with plain SQL: before migration 0095 the columns do not
 * exist, which answers as "no such column", caught here and nowhere else.
 */
async function readSemanticRow(env: CloudflareEnv): Promise<SemanticSettingsRow | null> {
	try {
		const row = await env.DB.prepare(
			`SELECT semantic_search_enabled AS semanticSearchEnabled, semantic_embedding_provider AS semanticEmbeddingProvider,
				semantic_compatible_base_url AS semanticCompatibleBaseUrl, semantic_compatible_api_key AS semanticCompatibleApiKey,
				semantic_backfill_cursor AS semanticBackfillCursor, semantic_backfill_paused AS semanticBackfillPaused,
				semantic_backfill_cap_share AS semanticBackfillCapShare
			FROM app_settings WHERE id = ?`,
		)
			.bind(AGENT_SETTINGS_ID)
			.first<SemanticSettingsRow>();
		return row ?? null;
	} catch (error) {
		if (isNoSuchTableError(error) || /no such column/i.test(error instanceof Error ? error.message : "")) return null;
		throw error;
	}
}

function parseCursor(value: string | null | undefined): SemanticBackfillCursor | null {
	if (!value) return null;
	try {
		const parsed = JSON.parse(value) as unknown;
		if (
			parsed &&
			typeof parsed === "object" &&
			typeof (parsed as SemanticBackfillCursor).createdAt === "number" &&
			typeof (parsed as SemanticBackfillCursor).id === "string"
		)
			return parsed as SemanticBackfillCursor;
		return null;
	} catch {
		return null;
	}
}

/** Reads its defaults on a database that has not applied migration 0095 yet, or has no settings row saved. */
export async function getSemanticInstallSettings(env: CloudflareEnv): Promise<SemanticInstallSettings> {
	const saved = await readSemanticRow(env);
	if (!saved) return DEFAULT_SETTINGS;
	return {
		enabled: !!saved.semanticSearchEnabled,
		embeddingProvider: saved.semanticEmbeddingProvider,
		compatibleBaseUrl: saved.semanticCompatibleBaseUrl,
		backfillCursor: parseCursor(saved.semanticBackfillCursor),
		backfillPaused: !!saved.semanticBackfillPaused,
		backfillCapShare: saved.semanticBackfillCapShare ?? DEFAULT_SETTINGS.backfillCapShare,
	};
}

/**
 * The admin-configured compatible endpoint's key, opened. `keyUnreadable` means it was sealed under a different
 * `APP_ENCRYPTION_KEY` (a restore into another install, a rotated key): the embedding call fails and says why
 * instead of silently sending no key.
 */
export async function getSemanticCompatibleApiKey(
	env: CloudflareEnv,
): Promise<{ apiKey: string | null; keyUnreadable: boolean }> {
	const saved = await readSemanticRow(env);
	if (!saved?.semanticCompatibleApiKey) return { apiKey: null, keyUnreadable: false };
	try {
		return { apiKey: await openSetting(env, saved.semanticCompatibleApiKey), keyUnreadable: false };
	} catch (error) {
		if (error instanceof SecretBoxError) return { apiKey: null, keyUnreadable: true };
		throw error;
	}
}

export function formatBackfillCursor(cursor: SemanticBackfillCursor | null): string | null {
	return cursor ? JSON.stringify(cursor) : null;
}

export type SaveSemanticAdminSettingsInput = {
	enabled?: boolean;
	embeddingProvider?: "workers_ai" | "compatible" | null;
	compatibleBaseUrl?: string | null;
	/** Undefined keeps the stored key; an empty string clears it. */
	compatibleApiKey?: string;
	backfillPaused?: boolean;
	backfillCapShare?: number;
};

/**
 * Saves the admin's changes. The row is created first (plain SQL, so it never fails before migration 0095 the way
 * a Drizzle insert naming every mapped column would), then updated with only the given columns. Turning the
 * feature off goes through `disableSemanticSearch` instead, which also clears the index; this never does that.
 */
export async function saveSemanticAdminSettings(
	env: CloudflareEnv,
	input: SaveSemanticAdminSettingsInput,
): Promise<void> {
	await env.DB.prepare("INSERT INTO app_settings (id) VALUES (?) ON CONFLICT(id) DO NOTHING")
		.bind(AGENT_SETTINGS_ID)
		.run();
	const sets: string[] = [];
	const params: unknown[] = [];
	const set = (column: string, value: unknown) => {
		sets.push(`${column} = ?`);
		params.push(value);
	};
	if (input.enabled !== undefined) set("semantic_search_enabled", input.enabled);
	if (input.embeddingProvider !== undefined) set("semantic_embedding_provider", input.embeddingProvider);
	if (input.compatibleBaseUrl !== undefined) set("semantic_compatible_base_url", input.compatibleBaseUrl);
	if (input.compatibleApiKey !== undefined)
		set("semantic_compatible_api_key", input.compatibleApiKey ? await sealSetting(env, input.compatibleApiKey) : null);
	if (input.backfillPaused !== undefined) set("semantic_backfill_paused", input.backfillPaused);
	if (input.backfillCapShare !== undefined) set("semantic_backfill_cap_share", input.backfillCapShare);
	if (sets.length === 0) return;
	params.push(AGENT_SETTINGS_ID);
	await env.DB.prepare(`UPDATE app_settings SET ${sets.join(", ")} WHERE id = ?`)
		.bind(...params)
		.run();
}
