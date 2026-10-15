import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts, users } from "@/db/schema";
import { normalizeEmailAddress } from "@/lib/email/address";
import { createAuditLog } from "@/lib/mailboxes/audit";
import { notifyUsersOfNewMessage } from "@/lib/realtime/utils";
import type { HostContact, HostNotice, HostUserProfile } from "./host-types";
import { cleanNotice } from "./host-utils";
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

/** The viewer's contact for an address. A module can look up only the acting user's own contacts. */
export async function findViewerContact(
	env: CloudflareEnv,
	ctx: CapabilityCallContext,
	userId: string,
	email: string,
): Promise<HostContact | null> {
	if (!ctx.viewer || ctx.viewer.userId !== userId) return null;
	const address = typeof email === "string" ? normalizeEmailAddress(email) : "";
	if (!address) return null;
	const [contact] = await getDb(env)
		.select({ id: contacts.id, displayName: contacts.displayName })
		.from(contacts)
		.where(and(eq(contacts.userId, userId), eq(contacts.email, address)))
		.limit(1);
	return contact ?? null;
}

/**
 * Sends a module notice over realtime to each listed user for whom the module is on. A notice with an
 * unusable id, title or link is refused with an error; delivery itself is best-effort.
 */
export async function notifyModuleUsers(
	env: CloudflareEnv,
	moduleId: ModuleId,
	userIds: string[],
	notice: HostNotice,
): Promise<void> {
	const clean = cleanNotice(notice);
	if (!clean) throw new Error("A module notice needs an id, a title and a same-origin link");
	const recipients: string[] = [];
	for (const userId of new Set(userIds.filter((id) => typeof id === "string" && id)))
		if (await isModuleEnabledForUser(env, userId, moduleId)) recipients.push(userId);
	if (recipients.length === 0) return;
	await notifyUsersOfNewMessage(env, recipients, { type: "module_notice", moduleId, ...clean });
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
