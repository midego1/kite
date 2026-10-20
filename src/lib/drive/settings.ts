import { asc, eq, gt, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { driveItems, driveUserQuotas } from "@/db/schema/drive";
import { queryInChunks } from "@/db/chunk-utils";
import { createAuditLog } from "@/lib/mailboxes/audit";
import { fail, notFound, ok } from "./errors";
import { getDriveSettings, saveDriveSettings } from "./quota";
import { effectiveQuota, mayChangeQuota, parseQuotaBytes, type QuotaActor as Actor } from "./quota-utils";
import { applySettingsPatch } from "./settings-utils";
import type { DriveAnswer } from "./types";

const USAGE_PAGE_SIZE = 50;

export async function getSettingsView(env: CloudflareEnv): Promise<DriveAnswer> {
	return ok({ settings: await getDriveSettings(env) });
}

export async function updateSettings(env: CloudflareEnv, actor: Actor, body: unknown): Promise<DriveAnswer> {
	const current = await getDriveSettings(env);
	const next = applySettingsPatch(current, body);
	if ("error" in next) return fail(400, next.error);
	await saveDriveSettings(env, next.settings, actor.id);
	await createAuditLog(env, {
		actorUserId: actor.id,
		action: "drive.settings_updated",
		metadata: { before: current, after: next.settings },
	});
	return ok({ settings: next.settings });
}

/** One page of accounts (by email) with their usage, override and the limit that applies to them. */
export async function listUsage(env: CloudflareEnv, actor: Actor, cursor: string | null): Promise<DriveAnswer> {
	const db = getDb(env);
	const accounts = await db
		.select({
			id: users.id,
			name: users.name,
			email: users.email,
			role: users.role,
			isPrimaryAdmin: users.isPrimaryAdmin,
			disabled: users.disabled,
		})
		.from(users)
		.where(cursor ? gt(users.email, cursor) : undefined)
		.orderBy(asc(users.email))
		.limit(USAGE_PAGE_SIZE);
	const ids = accounts.map((account) => account.id);
	const [used, overrides, settings] = await Promise.all([
		queryInChunks(ids, (chunk) =>
			db
				.select({ ownerId: driveItems.ownerId, total: sql<number>`coalesce(sum(${driveItems.size}), 0)` })
				.from(driveItems)
				.where(inArray(driveItems.ownerId, chunk))
				.groupBy(driveItems.ownerId),
		),
		queryInChunks(ids, (chunk) => db.select().from(driveUserQuotas).where(inArray(driveUserQuotas.userId, chunk))),
		getDriveSettings(env),
	]);
	const usedBy = new Map(used.map((row) => [row.ownerId, Number(row.total)]));
	const overrideBy = new Map(overrides.map((row) => [row.userId, row]));
	return ok({
		accounts: accounts.map((account) => ({
			id: account.id,
			name: account.name,
			email: account.email,
			disabled: account.disabled,
			used: usedBy.get(account.id) ?? 0,
			override: overrideBy.has(account.id) ? { quotaBytes: overrideBy.get(account.id)!.quotaBytes } : null,
			limit: effectiveQuota(overrideBy.get(account.id), settings.defaultQuotaBytes),
			editable: mayChangeQuota(actor, account),
		})),
		nextCursor: accounts.length === USAGE_PAGE_SIZE ? accounts[accounts.length - 1].email : null,
		defaultQuotaBytes: settings.defaultQuotaBytes,
	});
}

async function editableAccount(env: CloudflareEnv, actor: Actor, userId: string) {
	const [account] = await getDb(env)
		.select({ id: users.id, role: users.role, isPrimaryAdmin: users.isPrimaryAdmin })
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);
	return account && mayChangeQuota(actor, account) ? account : null;
}

/** `PUT /api/drive/settings/quotas/[userId]` `{ quotaBytes }`: null is unlimited for this account. */
export async function setQuotaOverride(
	env: CloudflareEnv,
	actor: Actor,
	userId: string,
	body: unknown,
): Promise<DriveAnswer> {
	const account = await editableAccount(env, actor, userId);
	if (!account) return notFound();
	const quotaBytes = parseQuotaBytes((body as { quotaBytes?: unknown } | null)?.quotaBytes);
	if (quotaBytes === undefined) return fail(400, "The quota must be a whole number of bytes or null for unlimited");
	const now = new Date();
	await getDb(env)
		.insert(driveUserQuotas)
		.values({ userId, quotaBytes, updatedAt: now })
		.onConflictDoUpdate({ target: driveUserQuotas.userId, set: { quotaBytes, updatedAt: now } });
	await createAuditLog(env, {
		actorUserId: actor.id,
		targetUserId: userId,
		action: "drive.quota_set",
		metadata: { quotaBytes },
	});
	return ok({ override: { quotaBytes } });
}

export async function clearQuotaOverride(env: CloudflareEnv, actor: Actor, userId: string): Promise<DriveAnswer> {
	const account = await editableAccount(env, actor, userId);
	if (!account) return notFound();
	await getDb(env).delete(driveUserQuotas).where(eq(driveUserQuotas.userId, userId));
	await createAuditLog(env, { actorUserId: actor.id, targetUserId: userId, action: "drive.quota_cleared" });
	return ok({ override: null });
}
