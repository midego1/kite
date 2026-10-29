import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { externalAccounts } from "@/db/schema/external-accounts";
import { canManageUsers, isPrimaryAdmin } from "@/lib/auth/admin";
import type { SessionUser } from "@/lib/auth/types";
import { readCanConnect, setCanConnect } from "./access";
import { auditExternalAccount } from "./audit";
import { ExternalAccountRefusal, externalAccountTablesReady } from "./errors";
import { readInstallState, setInstallEnabled } from "./settings";

type Actor = Pick<SessionUser, "id" | "role" | "isPrimaryAdmin" | "canManageUsers">;

/** The install switch as Admin → General shows it, with how many accounts exist (never whose or which). */
export async function loadInstallSwitch(env: CloudflareEnv) {
	const state = await readInstallState(env);
	const ready = !state.migrationPending && (await externalAccountTablesReady(env));
	const accounts = ready ? await getDb(env).select({ id: externalAccounts.id }).from(externalAccounts) : [];
	return {
		enabled: state.enabled,
		keyConfigured: state.keyConfigured,
		disabledAt: state.disabledAt?.toISOString() ?? null,
		migrationPending: !ready,
		accounts: accounts.length,
	};
}

export async function changeInstallSwitch(env: CloudflareEnv, actor: Actor, enabled: boolean) {
	if (!(await externalAccountTablesReady(env)))
		throw new ExternalAccountRefusal(409, "Apply the pending database update first", "MIGRATION_PENDING");
	const before = await readInstallState(env);
	await setInstallEnabled(env, enabled);
	if (before.enabled !== enabled)
		await auditExternalAccount(env, {
			actorUserId: actor.id,
			action: "external_account.install_switch_changed",
			metadata: { enabled },
		});
	return loadInstallSwitch(env);
}

type Target = { id: string; role: "admin" | "user"; isPrimaryAdmin: boolean };

async function loadTarget(env: CloudflareEnv, userId: string): Promise<Target> {
	const [target] = await getDb(env)
		.select({ id: users.id, role: users.role, isPrimaryAdmin: users.isPrimaryAdmin })
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);
	if (!target) throw new ExternalAccountRefusal(404, "Account not found");
	return target;
}

/** Who may change the permission: the primary admin, or a user manager for plain users (as with the other flags). */
const mayEdit = (actor: Actor, target: Target) =>
	isPrimaryAdmin(actor) || (canManageUsers(actor) && target.role === "user" && !target.isPrimaryAdmin);

/**
 * A user's permission and their connected accounts as admins see them (spec §11.1): how many there are and in which
 * states, never the addresses, servers, credentials or mail.
 */
export async function loadUserConnectAccess(env: CloudflareEnv, actor: Actor, userId: string) {
	const target = await loadTarget(env, userId);
	const ready = await externalAccountTablesReady(env);
	const rows = ready
		? await getDb(env)
				.select({ status: externalAccounts.status })
				.from(externalAccounts)
				.where(eq(externalAccounts.userId, userId))
		: [];
	const states: Partial<Record<(typeof rows)[number]["status"], number>> = {};
	for (const row of rows) states[row.status] = (states[row.status] ?? 0) + 1;
	return {
		allowed: await readCanConnect(env, userId),
		editable: mayEdit(actor, target),
		migrationPending: !ready,
		accounts: { total: rows.length, states },
	};
}

export async function changeUserConnectAccess(env: CloudflareEnv, actor: Actor, userId: string, allowed: boolean) {
	const target = await loadTarget(env, userId);
	if (!mayEdit(actor, target)) throw new ExternalAccountRefusal(403, "You cannot change this account's permissions");
	await setCanConnect(env, userId, allowed);
	await auditExternalAccount(env, {
		actorUserId: actor.id,
		targetUserId: userId,
		action: "external_account.permission_changed",
		metadata: { allowed },
	});
	return loadUserConnectAccess(env, actor, userId);
}
