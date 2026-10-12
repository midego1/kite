import { asc, eq } from "drizzle-orm";
import { createDb } from "@/db";
import { users } from "@/db/schema";
import { userModuleAccess } from "@/db/schema/modules";
import { createAuditLog } from "@/lib/mailboxes/audit";
import { MODULE_CAPABILITIES } from "./capability-registry";
import type { ModuleAdminFailure, ModuleAdminView, UserModuleAccessView } from "./admin-types";
import { blockingDependency, buildModuleAdminEntries } from "./admin-utils";
import type { ModuleId } from "./module-types";
import { MODULE_MANIFESTS } from "./registry";
import { readStoredInstallState, readStoredUserAccess, setModuleEnabled, setUserModuleAllowed } from "./state";

type AdminEnv = CloudflareEnv;
type Actor = { id: string };

const MIGRATION_PENDING: ModuleAdminFailure = {
	ok: false,
	status: 409,
	code: "MIGRATION_PENDING",
	error: "Apply the pending database update to manage modules",
};

/** Everything the Modules page shows, from what is stored rather than from the isolate's cached answer. */
export async function loadModuleAdminView(env: AdminEnv): Promise<ModuleAdminView> {
	const { ready, flags } = await readStoredInstallState(env);
	const restricted = ready
		? await createDb(env.DB)
				.select({ id: users.id, name: users.name, email: users.email, moduleId: userModuleAccess.moduleId })
				.from(userModuleAccess)
				.innerJoin(users, eq(users.id, userModuleAccess.userId))
				.where(eq(userModuleAccess.allowed, false))
				.orderBy(asc(users.email))
		: [];
	return {
		migrationPending: !ready,
		modules: buildModuleAdminEntries({
			manifests: MODULE_MANIFESTS,
			capabilities: MODULE_CAPABILITIES,
			install: flags,
			restricted,
		}),
	};
}

/** The stored install switch plus the user's own access, one row per module in registry order. */
export async function loadUserModuleAccess(env: AdminEnv, userId: string): Promise<UserModuleAccessView> {
	const [install, access] = await Promise.all([readStoredInstallState(env), readStoredUserAccess(env, userId)]);
	return {
		migrationPending: !install.ready,
		modules: MODULE_MANIFESTS.map((manifest) => ({
			id: manifest.id,
			name: manifest.name,
			description: manifest.description,
			installEnabled: install.flags.get(manifest.id) ?? manifest.defaultEnabled,
			allowed: access.flags.get(manifest.id) ?? true,
		})),
	};
}

/**
 * Turns a module on or off for the install and records it. Turning one on needs every dependency on,
 * and turning one off never touches the stored flag of anything that depends on it.
 */
export async function setInstallModule(
	env: AdminEnv,
	actor: Actor,
	input: { moduleId: ModuleId; enabled: boolean },
): Promise<{ ok: true; changed: boolean } | ModuleAdminFailure> {
	const stored = await readStoredInstallState(env);
	if (!stored.ready) return MIGRATION_PENDING;
	if (input.enabled) {
		const blocking = blockingDependency(MODULE_MANIFESTS, stored.flags, input.moduleId);
		if (blocking) {
			return {
				ok: false,
				status: 409,
				code: "MODULE_DEPENDENCY",
				error: `Turn on ${blocking.name} first. It is needed by this module.`,
			};
		}
	}
	if (stored.flags.get(input.moduleId) === input.enabled) return { ok: true, changed: false };
	await setModuleEnabled(env, { ...input, updatedBy: actor.id });
	await createAuditLog(env, {
		actorUserId: actor.id,
		action: input.enabled ? "module.enabled" : "module.disabled",
		metadata: { moduleId: input.moduleId },
	});
	return { ok: true, changed: true };
}

/**
 * Allows or restricts modules for one user and records each change with a ref to that user. The primary
 * admin always has access, so a restriction on that account is refused instead of stored and ignored.
 */
export async function setUserModuleAccess(
	env: AdminEnv,
	actor: Actor,
	userId: string,
	changes: { moduleId: ModuleId; allowed: boolean }[],
): Promise<{ ok: true; changed: number } | ModuleAdminFailure> {
	const [target] = await createDb(env.DB)
		.select({ id: users.id, isPrimaryAdmin: users.isPrimaryAdmin })
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);
	if (!target) return { ok: false, status: 404, code: "USER_NOT_FOUND", error: "Account not found" };
	if (target.isPrimaryAdmin && changes.some((change) => !change.allowed)) {
		return {
			ok: false,
			status: 400,
			code: "OWNER_ACCESS",
			error: "The primary admin always has access to every module",
		};
	}
	if (!(await readStoredInstallState(env)).ready) return MIGRATION_PENDING;
	const stored = await readStoredUserAccess(env, userId);
	let changed = 0;
	for (const change of changes) {
		if (target.isPrimaryAdmin || (stored.flags.get(change.moduleId) ?? true) === change.allowed) continue;
		await setUserModuleAllowed(env, { userId, ...change, updatedBy: actor.id });
		await createAuditLog(env, {
			actorUserId: actor.id,
			targetUserId: userId,
			action: "module.user_access",
			metadata: { moduleId: change.moduleId, allowed: change.allowed, ref: { kind: "user:user", id: userId } },
		});
		changed++;
	}
	return { ok: true, changed };
}
