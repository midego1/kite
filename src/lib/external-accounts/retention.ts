import { and, lt, ne } from "drizzle-orm";
import { getDb } from "@/db";
import { externalAccounts } from "@/db/schema/external-accounts";
import { auditExternalAccount } from "./audit";
import { externalAccountTablesReady } from "./errors";
import { eraseOrphanAccessTokens, pruneOAuthStates } from "./oauth-store";

/** How long saved passwords outlive the install switch being off, or the owner's permission being revoked. */
const IDLE_CREDENTIALS_MAX_AGE_MS = 30 * 24 * 60 * 60_000;

/**
 * Daily (02:00 UTC): erases the passwords Kite has not been allowed to use for 30 days (spec §9.3, §11.1), counted
 * from `suspended_at` (set when the owner's permission was revoked or the install switch went off, and never moved by
 * edits), whatever the account's status, and marks those accounts `disabled`. Reconnecting makes one active again.
 * An OAuth account's refresh token is its `secret`, so it goes the same way, with the cached access token. Sign-ins
 * with Microsoft that were started and never finished are dropped too.
 */
export async function eraseIdleExternalCredentials(env: CloudflareEnv, now = new Date()): Promise<number> {
	if (!(await externalAccountTablesReady(env))) return 0;
	const cutoff = new Date(now.getTime() - IDLE_CREDENTIALS_MAX_AGE_MS);
	const erased = await getDb(env)
		.update(externalAccounts)
		.set({ secret: "", status: "disabled", statusReason: "credentials_erased", updatedAt: now })
		.where(and(ne(externalAccounts.secret, ""), lt(externalAccounts.suspendedAt, cutoff)))
		.returning({ id: externalAccounts.id, userId: externalAccounts.userId });
	// An OAuth account's refresh token was its `secret`; its cached access token goes with it.
	await eraseOrphanAccessTokens(env);
	for (const account of erased)
		await auditExternalAccount(env, {
			actorUserId: null,
			targetUserId: account.userId,
			action: "external_account.credentials_erased",
			metadata: { accountId: account.id },
		});
	await pruneOAuthStates(env, now).catch(() => undefined);
	return erased.length;
}
