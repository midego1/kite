import { and, count, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { domains, mailboxes, users } from "@/db/schema";
import { moduleSettings } from "@/db/schema/modules";
import { getAgentEnabled } from "@/lib/agent/provider";
import { readStoredAgentProvider } from "@/lib/agent/provider-connections";
import { domainOwnerId } from "@/lib/domains/owner-utils";
import { getBackupHealth } from "@/lib/backups/service";
import { getPendingMigrationStatus } from "@/lib/migrations/pending";
import { readLayoutPreferences, saveLayoutPreferences } from "@/lib/preferences/layout";
import { resolveAbuseChKey } from "@/lib/spam/providers/abuse-ch-key";
import type { SessionUser } from "@/lib/auth/types";
import type { OnboardingChecklistState } from "./onboarding-checklist-types";

/** The real state behind every checklist item, read fresh on every load so items flip on their own. */
export async function loadOnboardingChecklistState(
	env: CloudflareEnv,
	user: SessionUser,
): Promise<OnboardingChecklistState> {
	const db = getDb(env);
	const [domainRow, mailboxRow, accountRow, moduleRow, agentEnabled, storedProvider, backups, migrations, abuseChKey] =
		await Promise.all([
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
			db
				.select({ total: count() })
				.from(moduleSettings)
				.then((rows) => rows[0]),
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
		modulesConfigured: moduleRow.total > 0,
		spamKeyConfigured: abuseChKey !== null,
		assistantConfigured: !agentEnabled || storedProvider !== null,
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
