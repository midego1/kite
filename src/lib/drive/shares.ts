import { and, asc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { driveShares } from "@/db/schema/drive";
import { newId } from "@/lib/ids";
import { isModuleEnabledFor } from "@/lib/modules/state";
import { getDriveItem, getDriveRole } from "./access";
import { fail, notFound, ok } from "./errors";
import { canEditDrive } from "./name-utils";
import type { DriveAnswer, DriveRole, DriveRow, DriveShareDto, DriveUser } from "./types";

type Db = ReturnType<typeof getDb>;
const MAX_CANDIDATES = 200;

/** An item the user may share (owner or editor), with their role; null otherwise. */
async function shareableItem(
	env: CloudflareEnv,
	user: DriveUser,
	id: string,
): Promise<{ item: DriveRow; role: DriveRole } | null> {
	const db = getDb(env);
	const item = await getDriveItem(db, id);
	const role = item ? (await getDriveRole(db, user.id, item)).role : null;
	return item && canEditDrive(role) ? { item, role: role! } : null;
}

async function listShares(db: Db, itemId: string): Promise<DriveShareDto[]> {
	const rows = await db
		.select({
			id: driveShares.id,
			userId: driveShares.userId,
			name: users.name,
			email: users.email,
			role: driveShares.role,
		})
		.from(driveShares)
		.innerJoin(users, eq(driveShares.userId, users.id))
		.where(eq(driveShares.itemId, itemId))
		.orderBy(asc(driveShares.createdAt));
	return rows.map((row) => ({ ...row, role: row.role as DriveShareDto["role"] }));
}

/** Active accounts that can use Drive, other than the item's owner, for the share picker. */
async function shareCandidates(
	env: CloudflareEnv,
	ownerId: string,
): Promise<{ id: string; name: string; email: string }[]> {
	const rows = await getDb(env)
		.select({
			id: users.id,
			name: users.name,
			email: users.email,
			role: users.role,
			isPrimaryAdmin: users.isPrimaryAdmin,
		})
		.from(users)
		.where(eq(users.disabled, false))
		.orderBy(asc(users.email))
		.limit(MAX_CANDIDATES);
	const allowed = await Promise.all(
		rows.map(
			async (row) =>
				row.id !== ownerId &&
				(await isModuleEnabledFor(
					env,
					{ userId: row.id, role: row.role, isPrimaryAdmin: row.isPrimaryAdmin },
					"drive",
				)),
		),
	);
	return rows.filter((_, index) => allowed[index]).map(({ id, name, email }) => ({ id, name, email }));
}

export async function getShares(env: CloudflareEnv, user: DriveUser, id: string): Promise<DriveAnswer> {
	const target = await shareableItem(env, user, id);
	if (!target) return notFound();
	const [shares, candidates] = await Promise.all([
		listShares(getDb(env), id),
		shareCandidates(env, target.item.ownerId),
	]);
	return ok({ shares, candidates, role: target.role });
}

/**
 * `POST /api/drive/items/[id]/shares` `{ userId | email, role }`. Owners and editors may share with view;
 * only the owner grants edit or changes an existing edit share.
 */
export async function addShare(env: CloudflareEnv, user: DriveUser, id: string, body: unknown): Promise<DriveAnswer> {
	const target = await shareableItem(env, user, id);
	if (!target) return notFound();
	const value = (body ?? {}) as { userId?: unknown; email?: unknown; role?: unknown };
	const role = value.role === "edit" ? "edit" : "view";
	if (role === "edit" && target.role !== "owner") return fail(403, "Only the owner can give edit access");
	const db = getDb(env);
	const email = typeof value.email === "string" ? value.email.trim().toLowerCase() : "";
	const [recipient] = await db
		.select({ id: users.id, role: users.role, isPrimaryAdmin: users.isPrimaryAdmin, disabled: users.disabled })
		.from(users)
		.where(typeof value.userId === "string" ? eq(users.id, value.userId) : eq(users.email, email))
		.limit(1);
	const usable =
		recipient &&
		!recipient.disabled &&
		(await isModuleEnabledFor(
			env,
			{ userId: recipient.id, role: recipient.role, isPrimaryAdmin: recipient.isPrimaryAdmin },
			"drive",
		));
	if (!usable) return fail(404, "No account with Drive uses that address");
	if (recipient.id === target.item.ownerId) return fail(400, "That account already owns this item");
	const [existing] = await db
		.select({ role: driveShares.role })
		.from(driveShares)
		.where(and(eq(driveShares.itemId, id), eq(driveShares.userId, recipient.id)))
		.limit(1);
	if (existing?.role === "edit" && target.role !== "owner") return fail(403, "Only the owner can change edit access");
	await db
		.insert(driveShares)
		.values({ id: newId("dsh"), itemId: id, userId: recipient.id, role, createdByUserId: user.id })
		.onConflictDoUpdate({ target: [driveShares.itemId, driveShares.userId], set: { role } });
	return ok({ shares: await listShares(db, id) });
}

/** Removes a share: the owner removes any, an editor only view shares. */
export async function removeShare(
	env: CloudflareEnv,
	user: DriveUser,
	id: string,
	shareId: string | null,
): Promise<DriveAnswer> {
	const target = await shareableItem(env, user, id);
	if (!target) return notFound();
	if (!shareId) return fail(400, "Missing share");
	const db = getDb(env);
	const [share] = await db
		.select({ role: driveShares.role })
		.from(driveShares)
		.where(and(eq(driveShares.id, shareId), eq(driveShares.itemId, id)))
		.limit(1);
	if (!share) return notFound();
	if (share.role === "edit" && target.role !== "owner") return fail(403, "Only the owner can remove edit access");
	await db.delete(driveShares).where(eq(driveShares.id, shareId));
	return ok({ shares: await listShares(db, id) });
}
