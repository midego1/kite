import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { createAuditLog } from "@/lib/mailboxes/audit";
import type { HostUserProfile } from "./host-types";
import type { CapabilityCallContext, JsonValue, ModuleId } from "./module-types";
import { isModuleEnabledFor } from "./state";

/** Whether a module is on for one user, for background work that has no viewer. */
export async function isModuleEnabledForUser(env: CloudflareEnv, userId: string, moduleId: ModuleId): Promise<boolean> {
	const [user] = await getDb(env)
		.select({ role: users.role, isPrimaryAdmin: users.isPrimaryAdmin })
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);
	if (!user) return false;
	return isModuleEnabledFor(
		env,
		{ userId, role: user.role, isPrimaryAdmin: user.role === "admin" && user.isPrimaryAdmin },
		moduleId,
	);
}

export async function getUserProfile(env: CloudflareEnv, userId: string): Promise<HostUserProfile | null> {
	const [user] = await getDb(env)
		.select({ id: users.id, name: users.name, email: users.email, timeZone: users.timeZone })
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);
	return user ?? null;
}

/** An audit row for what a module did, attributed to the acting user when there is one. */
export async function recordModuleAudit(
	env: CloudflareEnv,
	ctx: CapabilityCallContext,
	action: string,
	metadata: JsonValue,
): Promise<void> {
	await createAuditLog(env, {
		actorUserId: ctx.viewer?.userId ?? null,
		action,
		metadata:
			metadata !== null && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : { value: metadata },
	});
}
