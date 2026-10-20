import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { driveLinks } from "@/db/schema/drive";
import { hashPassword } from "@/lib/auth/password";
import { newId } from "@/lib/ids";
import { createAuditLog } from "@/lib/mailboxes/audit";
import { openSecret, sealSecret } from "@/lib/security/secret-box";
import { getDriveItem, getDriveRole } from "./access";
import { fail, notFound, ok } from "./errors";
import { generateLinkToken, hashLinkToken, isLinkActive, linkExpiry, parseLinkPassword } from "./link-utils";
import { getDriveSettings } from "./quota";
import type { DriveAnswer, DriveLinkDto, DriveLinkRow, DriveRow, DriveUser } from "./types";

const linkUrl = (origin: string, token: string) => `${origin}/d/${token}`;

/** The item, when the user owns it and can see it: only owners create and manage public links. */
async function ownedItem(env: CloudflareEnv, user: DriveUser, id: string): Promise<DriveRow | null> {
	const db = getDb(env);
	const item = await getDriveItem(db, id);
	if (!item || item.ownerId !== user.id) return null;
	return (await getDriveRole(db, user.id, item)).role === "owner" ? item : null;
}

async function tokenOf(env: CloudflareEnv, link: DriveLinkRow): Promise<string | null> {
	if (!link.tokenSealed || !env.APP_ENCRYPTION_KEY?.trim()) return null;
	try {
		return await openSecret(env.APP_ENCRYPTION_KEY, link.tokenSealed);
	} catch {
		return null;
	}
}

async function toLinkDto(
	env: CloudflareEnv,
	link: DriveLinkRow,
	origin: string,
	token?: string,
): Promise<DriveLinkDto> {
	const shown = token ?? (await tokenOf(env, link));
	return {
		id: link.id,
		itemId: link.itemId,
		url: shown ? linkUrl(origin, shown) : null,
		hasPassword: !!link.passwordHash,
		expiresAt: link.expiresAt.toISOString(),
		revokedAt: link.revokedAt?.toISOString() ?? null,
		downloadCount: link.downloadCount,
		lastAccessedAt: link.lastAccessedAt?.toISOString() ?? null,
		createdAt: link.createdAt.toISOString(),
		active: isLinkActive(link, new Date()),
	};
}

export async function listLinks(
	env: CloudflareEnv,
	user: DriveUser,
	itemId: string,
	origin: string,
): Promise<DriveAnswer> {
	if (!(await ownedItem(env, user, itemId))) return notFound();
	const rows = await getDb(env)
		.select()
		.from(driveLinks)
		.where(eq(driveLinks.itemId, itemId))
		.orderBy(desc(driveLinks.createdAt));
	const settings = await getDriveSettings(env);
	return ok({
		links: await Promise.all(rows.map((row) => toLinkDto(env, row, origin))),
		linkMaxDays: settings.linkMaxDays,
	});
}

/**
 * `POST /api/drive/items/[id]/links` `{ expiresInDays, password? }`. The token is shown in this answer;
 * afterwards only when APP_ENCRYPTION_KEY let it be sealed, since the database keeps just its hash.
 */
export async function createLink(
	env: CloudflareEnv,
	user: DriveUser,
	itemId: string,
	body: unknown,
	origin: string,
): Promise<DriveAnswer> {
	const item = await ownedItem(env, user, itemId);
	if (!item) return notFound();
	const value = (body ?? {}) as { expiresInDays?: unknown; password?: unknown };
	const now = new Date();
	const expiresAt = linkExpiry(value.expiresInDays, (await getDriveSettings(env)).linkMaxDays, now);
	if (!(expiresAt instanceof Date)) return fail(expiresAt.status, expiresAt.error);
	const password = parseLinkPassword(value.password);
	if (password === null) return fail(400, "Invalid password");
	const token = generateLinkToken();
	const row: DriveLinkRow = {
		id: newId("dln"),
		itemId,
		tokenHash: await hashLinkToken(token),
		tokenSealed: env.APP_ENCRYPTION_KEY?.trim() ? await sealSecret(env.APP_ENCRYPTION_KEY, token) : null,
		passwordHash: password ? hashPassword(password) : null,
		expiresAt,
		downloadCount: 0,
		lastAccessedAt: null,
		revokedAt: null,
		createdByUserId: user.id,
		createdAt: now,
	};
	await getDb(env).insert(driveLinks).values(row);
	await createAuditLog(env, {
		actorUserId: user.id,
		action: "drive.link_created",
		metadata: { itemId, kind: item.kind, linkId: row.id, expiresAt: expiresAt.toISOString(), password: !!password },
	});
	return ok({ link: await toLinkDto(env, row, origin, token) }, 201);
}

async function ownedLink(env: CloudflareEnv, user: DriveUser, linkId: string): Promise<DriveLinkRow | null> {
	const [link] = await getDb(env).select().from(driveLinks).where(eq(driveLinks.id, linkId)).limit(1);
	return link && (await ownedItem(env, user, link.itemId)) ? link : null;
}

/** `PATCH /api/drive/links/[id]` `{ expiresInDays }`: a new expiry from now, within the same bound; never none. */
export async function updateLink(
	env: CloudflareEnv,
	user: DriveUser,
	linkId: string,
	body: unknown,
	origin: string,
): Promise<DriveAnswer> {
	const link = await ownedLink(env, user, linkId);
	if (!link || link.revokedAt) return notFound();
	const value = (body ?? {}) as { expiresInDays?: unknown };
	const expiresAt = linkExpiry(value.expiresInDays, (await getDriveSettings(env)).linkMaxDays, new Date());
	if (!(expiresAt instanceof Date)) return fail(expiresAt.status, expiresAt.error);
	await getDb(env).update(driveLinks).set({ expiresAt }).where(eq(driveLinks.id, link.id));
	return ok({ link: await toLinkDto(env, { ...link, expiresAt }, origin) });
}

/** `DELETE /api/drive/links/[id]`: revokes the link; every later visit answers 404. */
export async function revokeLink(env: CloudflareEnv, user: DriveUser, linkId: string): Promise<DriveAnswer> {
	const link = await ownedLink(env, user, linkId);
	if (!link) return notFound();
	await getDb(env).update(driveLinks).set({ revokedAt: new Date() }).where(eq(driveLinks.id, link.id));
	return ok({ ok: true });
}
