import { and, eq, lt, ne } from "drizzle-orm";
import { getDb } from "@/db";
import { externalAccounts } from "@/db/schema/external-accounts";
import { auditExternalAccount } from "./audit";
import { externalAccountTablesReady } from "./errors";
import { readInstallState } from "./settings";

/** How long saved passwords outlive the install switch being off, or the owner's permission being revoked. */
const IDLE_CREDENTIALS_MAX_AGE_MS = 30 * 24 * 60 * 60_000;

/**
 * Daily (02:00 UTC): erases the passwords Kite may no longer use (spec §9.3, §11.1) and marks those accounts
 * `disabled`: every account once the install switch has been off for 30 days, and each account paused for 30 days
 * because its owner lost the permission. Reconnecting with the password makes an account active again.
 */
export async function eraseIdleExternalCredentials(env: CloudflareEnv, now = new Date()): Promise<number> {
	if (!(await externalAccountTablesReady(env))) return 0;
	const install = await readInstallState(env);
	const cutoff = new Date(now.getTime() - IDLE_CREDENTIALS_MAX_AGE_MS);
	const db = getDb(env);
	const erase = { secret: "", status: "disabled" as const, updatedAt: now };
	const erased: { id: string; userId: string }[] = [];
	if (!install.enabled && install.disabledAt && install.disabledAt < cutoff)
		erased.push(
			...(await db
				.update(externalAccounts)
				.set({ ...erase, statusReason: "install_off" })
				.where(ne(externalAccounts.secret, ""))
				.returning({ id: externalAccounts.id, userId: externalAccounts.userId })),
		);
	erased.push(
		...(await db
			.update(externalAccounts)
			.set(erase)
			.where(
				and(
					eq(externalAccounts.status, "paused"),
					eq(externalAccounts.statusReason, "permission_revoked"),
					lt(externalAccounts.updatedAt, cutoff),
				),
			)
			.returning({ id: externalAccounts.id, userId: externalAccounts.userId })),
	);
	for (const account of erased)
		await auditExternalAccount(env, {
			actorUserId: null,
			targetUserId: account.userId,
			action: "external_account.credentials_erased",
			metadata: { accountId: account.id },
		});
	return erased.length;
}
