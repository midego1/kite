import { and, count, eq, isNotNull } from "drizzle-orm";
import { getDb } from "@/db";
import { domains, mailboxes, users } from "@/db/schema";
import { moduleSettings } from "@/db/schema/modules";
import { isNoSuchTableError } from "@/lib/modules/state-utils";
import { getAgentEnabled } from "@/lib/agent/provider";
import { readStoredAgentProvider } from "@/lib/agent/provider-connections";
import { domainOwnerId } from "@/lib/domains/owner-utils";
import { getBackupHealth } from "@/lib/backups/service";
import { getPendingMigrationStatus } from "@/lib/migrations/pending";
import { readLayoutPreferences, saveLayoutPreferences } from "@/lib/preferences/layout";
import { resolveAbuseChKey } from "@/lib/spam/providers/abuse-ch-key";
import type { SessionUser } from "@/lib/auth/types";
import type { OnboardingChecklistState } from "./onboarding-checklist-types";

/**
 * Whether an owner actually changed a module's switch; `false` before migration 0062, like the rest of the modules
 * system. Migration 0062 itself seeds four rows (Calendar, Booking, Email templates, Mail import) with no
 * `updated_by`, so a row existing is not enough: only a row `setInstallModule` wrote counts.
 */
async function readModulesConfigured(env: CloudflareEnv): Promise<boolean> {
	try {
		const [row] = await getDb(env)
			.select({ total: count() })
			.from(moduleSettings)
			.where(isNotNull(moduleSettings.updatedBy));
		return (row?.total ?? 0) > 0;
	} catch (error) {
		if (!isNoSuchTableError(error)) throw error;
		return false;
	}
}

/** The real state behind every checklist item, read fresh on every load so items flip on their own. */
export async function loadOnboardingChecklistState(
	env: CloudflareEnv,
	user: SessionUser,
): Promise<OnboardingChecklistState> {
	const db = getDb(env);
	const [
		domainRow,
		mailboxRow,
		accountRow,
		modulesConfigured,
		agentEnabled,
		storedProvider,
		backups,
		migrations,
		abuseChKey,
	] = await Promise.all([
		db
			.select({ active: count() })
			.from(domains)
			.where(and(eq(domains.userId, domainOwnerId(user)), eq(domains.status, "active")))
			.then((rows) => rows[0]),
		db
			.select({ total: count() })
			.from(mailboxes)
			.then((rows) => rows[0]),
		db
			.select({ total: count() })
			.from(users)
			.then((rows) => rows[0]),
		readModulesConfigured(env),
		getAgentEnabled(env),
		readStoredAgentProvider(env),
		getBackupHealth(env),
		getPendingMigrationStatus(env.DB),
		resolveAbuseChKey(env),
	]);
	return {
		domainActive: domainRow.active > 0,
		mailboxCount: mailboxRow.total,
		accountCount: accountRow.total,
		modulesConfigured,
		spamKeyConfigured: abuseChKey !== null,
		// `readStoredAgentProvider` always resolves to a row (the single `app_settings` row migration 0012 seeds, read
		// as the legacy fallback), so `provider` itself, not the object, says whether one was actually chosen; a
		// provider whose sealed key a rotated APP_ENCRYPTION_KEY can no longer open is not usable either.
		assistantConfigured: !agentEnabled || (!!storedProvider?.provider && !storedProvider.keyUnreadable),
		backupsReady: !!backups.automatic?.enabled || !!backups.lastSuccess,
		migrationsPending: migrations.pending,
	};
}

/** Whether this owner (`isPrimaryAdmin`) dismissed the checklist; false before migration 0080. */
export async function readOnboardingChecklistDismissed(env: CloudflareEnv, userId: string): Promise<boolean> {
	const { layout } = await readLayoutPreferences(getDb(env), userId);
	return layout?.onboardingChecklistDismissed ?? false;
}

/** Saves this owner's choice; throws `LayoutPreferencesPendingError` before migration 0080. */
export async function saveOnboardingChecklistDismissed(
	env: CloudflareEnv,
	userId: string,
	dismissed: boolean,
): Promise<void> {
	await saveLayoutPreferences(getDb(env), userId, { onboardingChecklistDismissed: dismissed });
}
