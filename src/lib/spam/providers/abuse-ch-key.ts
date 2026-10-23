import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { appSettings } from "@/db/schema";
import { missingColumnFromError } from "@/lib/auth/user-lookup-utils";
import { createLogger } from "@/lib/logger.mjs";
import { isNodeRuntime } from "@/lib/runtime";
import { openSetting, sealSetting, SecretBoxError } from "@/lib/security/secret-box";
import type { SpamIntelligenceProvider } from "../types";
import { abuseChFetcher, spamIntelligenceProvider } from "./abuse-ch";
import type { AbuseChKeyStatus, ResolvedAbuseChKey } from "./abuse-ch-types";
import { abuseChAuthKey, abuseChSecretName, pickAbuseChKey } from "./abuse-ch-utils";

const logger = createLogger("spam");

type SavedKey = { key: string | null; unreadable: boolean; updatePending: boolean };

/** Thrown by `saveAbuseChKey` while migration 0068 has not been applied. */
export class AbuseChKeyUpdatePendingError extends Error {
	constructor() {
		super("Kite's database needs an update first. Apply the pending updates from the admin overview, then try again.");
		this.name = "AbuseChKeyUpdatePendingError";
	}
}

/** The key saved in Kite. A missing column (migration pending) or an undecryptable value reads as no key. */
async function readSavedKey(env: CloudflareEnv): Promise<SavedKey> {
	let stored: string | null | undefined;
	try {
		const [row] = await getDb(env)
			.select({ value: appSettings.abuseChAuthKey })
			.from(appSettings)
			.where(eq(appSettings.id, "default"))
			.limit(1);
		stored = row?.value;
	} catch (error) {
		if (missingColumnFromError(error)) return { key: null, unreadable: false, updatePending: true };
		throw error;
	}
	if (!stored) return { key: null, unreadable: false, updatePending: false };
	try {
		return { key: (await openSetting(env, stored))?.trim() || null, unreadable: false, updatePending: false };
	} catch (error) {
		if (!(error instanceof SecretBoxError)) throw error;
		logger.warn("spam.threat_lookup_key_unreadable", {});
		return { key: null, unreadable: true, updatePending: false };
	}
}

/** The key lookups use: the secret, or else the key saved in Kite. Reads D1 only without a secret. */
export async function resolveAbuseChKey(env: CloudflareEnv): Promise<ResolvedAbuseChKey | null> {
	const secret = abuseChAuthKey(env);
	return pickAbuseChKey(secret, secret ? null : (await readSavedKey(env)).key);
}

export async function getAbuseChKeyStatus(env: CloudflareEnv): Promise<AbuseChKeyStatus> {
	const secretName = abuseChSecretName(env);
	const nodeRuntime = isNodeRuntime(env);
	const saved = await readSavedKey(env);
	if (secretName)
		return { source: "secret", secretName, unreadable: false, updatePending: saved.updatePending, nodeRuntime };
	return {
		source: saved.key ? "settings" : null,
		secretName: null,
		unreadable: saved.unreadable,
		updatePending: saved.updatePending,
		nodeRuntime,
	};
}

export async function saveAbuseChKey(env: CloudflareEnv, key: string): Promise<void> {
	const values = { abuseChAuthKey: await sealSetting(env, key), updatedAt: new Date() };
	try {
		await getDb(env)
			.insert(appSettings)
			.values({ id: "default", ...values })
			.onConflictDoUpdate({ target: appSettings.id, set: values });
	} catch (error) {
		if (missingColumnFromError(error)) throw new AbuseChKeyUpdatePendingError();
		throw error;
	}
}

export async function clearAbuseChKey(env: CloudflareEnv): Promise<void> {
	try {
		await getDb(env)
			.update(appSettings)
			.set({ abuseChAuthKey: null, updatedAt: new Date() })
			.where(eq(appSettings.id, "default"));
	} catch (error) {
		if (missingColumnFromError(error)) throw new AbuseChKeyUpdatePendingError();
		throw error;
	}
}

/** For inbound mail: a failing read only turns lookups off for this message, never the rest of spam checks. */
async function savedKeyForLookups(env: CloudflareEnv): Promise<string | null> {
	try {
		return (await readSavedKey(env)).key;
	} catch (error) {
		logger.warn("spam.threat_lookup_key_read_failed", { error });
		return null;
	}
}

/** The provider inbound mail uses: the secret key, else the one saved in Kite, read lazily. */
export function configuredSpamIntelligenceProvider(
	env: CloudflareEnv,
	fetcher: typeof fetch = abuseChFetcher(env),
): SpamIntelligenceProvider {
	return spamIntelligenceProvider(env, fetcher, () => savedKeyForLookups(env));
}
