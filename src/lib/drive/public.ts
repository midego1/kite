import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { driveItems, driveLinks } from "@/db/schema/drive";
import { verifyPassword } from "@/lib/auth/password";
import { getDriveChain, getDriveItem } from "./access";
import { streamDriveFile } from "./content";
import { driveTablesReady } from "./errors";
import {
	createUnlockValue,
	hashLinkToken,
	isLinkActive,
	isWellFormedLinkToken,
	readCookie,
	unlockCookieName,
	verifyUnlockValue,
} from "./link-utils";
import { toDriveCrumbs } from "./name-utils";
import { getDriveSettings } from "./quota";
import type { DriveLinkRow, DriveRow } from "./types";

export type PublicTarget = { link: DriveLinkRow; root: DriveRow; item: DriveRow };

/** The only fields a visitor sees: never the owner, the store or the key. */
const publicItem = (row: DriveRow) => ({
	id: row.id,
	kind: row.kind,
	name: row.name,
	size: row.size,
	contentType: row.contentType,
	updatedAt: row.updatedAt.toISOString(),
});

async function ownerActive(db: ReturnType<typeof getDb>, ownerId: string): Promise<boolean> {
	const [owner] = await db.select({ disabled: users.disabled }).from(users).where(eq(users.id, ownerId)).limit(1);
	return !!owner && !owner.disabled;
}

/**
 * Resolves a link token, re-checked on every request: the link is live, links are on, the owner's account is enabled, nothing on the way
 * down is trashed, and a descendant `itemId` lies inside the shared subtree. Any failure is null, which
 * every caller answers with the same 404.
 */
export async function resolvePublicLink(
	env: CloudflareEnv,
	token: string,
	itemId: string | null,
): Promise<PublicTarget | null> {
	if (!isWellFormedLinkToken(token) || !(await driveTablesReady(env))) return null;
	const db = getDb(env);
	const [link] = await db
		.select()
		.from(driveLinks)
		.where(eq(driveLinks.tokenHash, await hashLinkToken(token)))
		.limit(1);
	if (!link || !isLinkActive(link, new Date())) return null;
	if ((await getDriveSettings(env)).linkMaxDays <= 0) return null;
	const root = await getDriveItem(db, link.itemId);
	if (!root || root.status !== "ready" || !(await ownerActive(db, root.ownerId))) return null;
	const item = !itemId || itemId === root.id ? root : await getDriveItem(db, itemId);
	if (!item || item.status !== "ready") return null;
	const chain = await getDriveChain(db, item);
	if (chain.some((entry) => entry.trashedAt) || !chain.some((entry) => entry.id === root.id)) return null;
	return { link, root, item };
}

/** Whether a password link has been unlocked in this browser; links without a password always are. */
export async function isUnlocked(request: Request, link: DriveLinkRow): Promise<boolean> {
	if (!link.passwordHash) return true;
	const cookie = readCookie(request.headers.get("cookie"), unlockCookieName(link.id));
	return verifyUnlockValue({ id: link.id, passwordHash: link.passwordHash }, cookie, new Date());
}

async function touch(env: CloudflareEnv, link: DriveLinkRow, download: boolean): Promise<void> {
	await getDb(env)
		.update(driveLinks)
		.set({
			lastAccessedAt: new Date(),
			...(download ? { downloadCount: sql`${driveLinks.downloadCount} + 1` } : {}),
		})
		.where(eq(driveLinks.id, link.id));
}

/** `GET /api/public/drive/[token]?item=`: the item, the folder listing and the path inside the shared subtree. */
export async function publicMetadata(env: CloudflareEnv, target: PublicTarget) {
	const db = getDb(env);
	const children =
		target.item.kind === "folder"
			? await db
					.select()
					.from(driveItems)
					.where(
						and(eq(driveItems.parentId, target.item.id), isNull(driveItems.trashedAt), eq(driveItems.status, "ready")),
					)
					.orderBy(asc(driveItems.kind), asc(driveItems.name))
					.limit(1000)
			: [];
	const chain = await getDriveChain(db, target.item);
	const path = toDriveCrumbs(chain.slice(chain.findIndex((entry) => entry.id === target.root.id)));
	await touch(env, target.link, false);
	return {
		item: publicItem(target.item),
		items: children.map(publicItem),
		path,
		expiresAt: target.link.expiresAt.toISOString(),
	};
}

export async function publicContent(
	env: CloudflareEnv,
	request: Request,
	target: PublicTarget,
	download: boolean,
): Promise<Response> {
	const response = await streamDriveFile(env, request, target.item, download);
	if (response.ok && request.method !== "HEAD" && !request.headers.get("range")) await touch(env, target.link, true);
	return response;
}

/** Checks a link password; on success the cookie value and lifetime to set. */
export async function unlockLink(
	link: DriveLinkRow,
	password: unknown,
): Promise<{ value: string; maxAge: number } | null> {
	if (!link.passwordHash || typeof password !== "string" || password.length > 200) return null;
	if (!verifyPassword(password, link.passwordHash)) return null;
	return createUnlockValue({ id: link.id, passwordHash: link.passwordHash, expiresAt: link.expiresAt }, new Date());
}

const PUBLIC_HEADERS = {
	"Cache-Control": "private, no-store",
	"Referrer-Policy": "no-referrer",
	"X-Robots-Tag": "noindex, nofollow",
};

export function publicJson(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return Response.json(body, { status, headers: { ...PUBLIC_HEADERS, ...headers } });
}

/** The one answer for every link that does not exist, expired, was revoked, or whose owner lost Drive. */
export const publicNotFound = () => publicJson({ error: "Not found" }, 404);
export const publicTooMany = () => publicJson({ error: "Too many requests; try again in a minute" }, 429);
export const passwordRequired = () => publicJson({ error: "This link needs a password", passwordRequired: true }, 401);
