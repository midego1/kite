import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { externalAccounts, userConnectPermissions } from "@/db/schema/external-accounts";
import { missingColumnFromError } from "@/lib/auth/user-lookup-utils";
import { externalAccountTablesReady, migrationPending } from "./errors";
import { readInstallState } from "./settings";
import { suspendAccounts } from "./suspend";
import type { ConnectRefusal } from "./types";

type AccessEnv = Pick<CloudflareEnv, "DB" | "APP_ENCRYPTION_KEY">;

/** `users.can_connect_accounts` (spec §9.3), true by default and before migration 0079. */
export async function readCanConnect(env: AccessEnv, userId: string): Promise<boolean> {
	try {
		const [row] = await getDb(env)
			.select({ allowed: userConnectPermissions.canConnectAccounts })
			.from(userConnectPermissions)
			.where(eq(userConnectPermissions.id, userId))
			.limit(1);
		return row?.allowed ?? false;
	} catch (error) {
		if (missingColumnFromError(error)) return true;
		throw error;
	}
}

/**
 * Why `userId` cannot use connected accounts right now, or null. Saved accounts of a refused user stay in place
 * (paused); nothing signs in with them until the reason goes away.
 */
export async function connectRefusal(env: AccessEnv, userId: string): Promise<ConnectRefusal | null> {
	if (!(await externalAccountTablesReady(env))) return "migration_pending";
	const install = await readInstallState(env);
	if (install.migrationPending) return "migration_pending";
	if (!install.keyConfigured) return "no_key";
	if (!install.enabled) return "install_off";
	if (!(await readCanConnect(env, userId))) return "not_permitted";
	return null;
}

export const CONNECT_REFUSAL_TEXT: Record<ConnectRefusal, string> = {
	migration_pending: "Apply the pending database update to use connected accounts.",
	no_key: "Connected accounts need APP_ENCRYPTION_KEY, so passwords are only ever saved encrypted. Ask your admin.",
	install_off: "Connected accounts are turned off for this Kite. Ask your admin.",
	not_permitted: "Your admin has not allowed you to connect accounts.",
};

/**
 * Grants or revokes the permission. Revoking marks every account of the user that still holds a password as suspended
 * from now (whatever its status), so the daily run erases those passwords 30 days later, and shows active ones as
 * paused (`permission_revoked`). Granting it again lifts the suspension, unless the install switch is off, and resumes
 * exactly the accounts it paused.
 */
export async function setCanConnect(env: AccessEnv, userId: string, allowed: boolean): Promise<void> {
	if (!(await externalAccountTablesReady(env))) throw migrationPending();
	const db = getDb(env);
	await db
		.update(userConnectPermissions)
		.set({ canConnectAccounts: allowed })
		.where(eq(userConnectPermissions.id, userId));
	const now = new Date();
	const mine = eq(externalAccounts.userId, userId);
	if (allowed) {
		if ((await readInstallState(env)).enabled) await db.update(externalAccounts).set({ suspendedAt: null }).where(mine);
		await db
			.update(externalAccounts)
			.set({ status: "active", statusReason: null, updatedAt: now })
			.where(and(mine, eq(externalAccounts.status, "paused"), eq(externalAccounts.statusReason, "permission_revoked")));
		return;
	}
	await suspendAccounts(env, mine, now);
	await db
		.update(externalAccounts)
		.set({ status: "paused", statusReason: "permission_revoked", updatedAt: now })
		.where(and(mine, eq(externalAccounts.status, "active")));
}
