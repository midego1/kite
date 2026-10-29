import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { externalAccountSettings } from "@/db/schema/external-accounts";
import { missingColumnFromError } from "@/lib/auth/user-lookup-utils";
import { ExternalAccountRefusal, migrationPending } from "./errors";

export type ExternalAccountsInstallState = {
	/** Whether users may connect accounts and saved accounts may be used. */
	enabled: boolean;
	/** APP_ENCRYPTION_KEY is set; without it the switch stays off (spec D9). */
	keyConfigured: boolean;
	/** When the owner turned the switch off, or null. */
	disabledAt: Date | null;
	/** Migration 0079 is not applied yet. */
	migrationPending: boolean;
};

const hasEncryptionKey = (env: Pick<CloudflareEnv, "APP_ENCRYPTION_KEY">) => !!env.APP_ENCRYPTION_KEY?.trim();

/**
 * The install switch **Allow connected accounts** (Admin → General, spec §9.3): on by default when APP_ENCRYPTION_KEY
 * is set, off and locked without it. Read through a narrow view of `app_settings`, so a database without migration
 * 0079 reads as "not yet available" instead of failing.
 */
export async function readInstallState(
	env: Pick<CloudflareEnv, "DB" | "APP_ENCRYPTION_KEY">,
): Promise<ExternalAccountsInstallState> {
	const keyConfigured = hasEncryptionKey(env);
	try {
		const [row] = await getDb(env)
			.select({
				enabled: externalAccountSettings.externalAccountsEnabled,
				disabledAt: externalAccountSettings.externalAccountsDisabledAt,
			})
			.from(externalAccountSettings)
			.where(eq(externalAccountSettings.id, "default"))
			.limit(1);
		return {
			enabled: keyConfigured && (row?.enabled ?? true),
			keyConfigured,
			disabledAt: row?.disabledAt ?? null,
			migrationPending: false,
		};
	} catch (error) {
		if (!missingColumnFromError(error)) throw error;
		return { enabled: false, keyConfigured, disabledAt: null, migrationPending: true };
	}
}

/**
 * Turns the switch on or off. Off records when, so the daily cron can erase the saved passwords 30 days later; on
 * clears it (accounts whose password was already erased need reconnecting). Without a key it cannot be turned on.
 */
export async function setInstallEnabled(
	env: Pick<CloudflareEnv, "DB" | "APP_ENCRYPTION_KEY">,
	enabled: boolean,
): Promise<ExternalAccountsInstallState> {
	const current = await readInstallState(env);
	if (current.migrationPending) throw migrationPending();
	if (enabled && !current.keyConfigured)
		throw new ExternalAccountRefusal(409, "Set APP_ENCRYPTION_KEY first: account passwords are only saved encrypted");
	const now = new Date();
	const values = {
		externalAccountsEnabled: enabled,
		externalAccountsDisabledAt: enabled ? null : (current.disabledAt ?? now),
		updatedAt: now,
	};
	await getDb(env)
		.insert(externalAccountSettings)
		.values({ id: "default", ...values })
		.onConflictDoUpdate({ target: externalAccountSettings.id, set: values });
	return readInstallState(env);
}
