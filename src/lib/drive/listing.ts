import { and, desc, eq, isNotNull, isNull, lt, ne, or, sql, type SQL } from "drizzle-orm";
import { getDb } from "@/db";
import { driveItems, driveShares } from "@/db/schema/drive";
import { getDriveItem, getDriveRole, withoutTrashedAncestors } from "./access";
import { driveTypesCondition } from "./categories";
import type { DriveCategory } from "./category-names-utils";
import { toDriveItemDtos } from "./dto";
import { notFound, ok } from "./errors";
import { containsPattern, DRIVE_PAGE_SIZE, nextDriveCursor, type DriveCursor } from "./list-utils";
import { toDriveCrumbs } from "./name-utils";
import { getDriveUsage } from "./quota";
import type { DriveAnswer, DriveRole, DriveRow, DriveUser, DriveView } from "./types";

type Db = ReturnType<typeof getDb>;

export type ListQuery = {
	view: DriveView;
	parentId: string | null;
	query: string;
	types: DriveCategory[];
	cursor: DriveCursor | null;
};

const seconds = (date: Date) => Math.floor(date.getTime() / 1000);

/** Rows after the cursor on `(column desc, id desc)`. */
function afterCursor(column: typeof driveItems.updatedAt | typeof driveItems.trashedAt, cursor: DriveCursor | null) {
	if (!cursor) return undefined;
	const at = new Date(cursor.at * 1000);
	return or(lt(column, at), and(eq(column, at), lt(driveItems.id, cursor.id)));
}

const visible = and(eq(driveItems.status, "ready"), isNull(driveItems.trashedAt));

async function page(
	db: Db,
	where: (SQL | undefined)[],
	cursor: DriveCursor | null,
	column: typeof driveItems.updatedAt | typeof driveItems.trashedAt = driveItems.updatedAt,
) {
	const rows = await db
		.select()
		.from(driveItems)
		.where(and(...where, afterCursor(column, cursor)))
		.orderBy(desc(column), desc(driveItems.id))
		.limit(DRIVE_PAGE_SIZE);
	const nextCursor = nextDriveCursor(rows, DRIVE_PAGE_SIZE, (row) => ({
		at: seconds((column === driveItems.trashedAt ? row.trashedAt : row.updatedAt) ?? row.updatedAt),
		id: row.id,
	}));
	return { rows, nextCursor };
}

/** The shared root a non-owner may see the breadcrumb from: the first folder in the chain shared with them. */
async function trimToSharedRoot(db: Db, userId: string, chain: DriveRow[]): Promise<DriveRow[]> {
	const shares = await db
		.select({ itemId: driveShares.itemId })
		.from(driveShares)
		.where(eq(driveShares.userId, userId));
	const shared = new Set(shares.map((share) => share.itemId));
	const index = chain.findIndex((entry) => shared.has(entry.id));
	return index < 0 ? chain.slice(-1) : chain.slice(index);
}

async function listFolder(env: CloudflareEnv, user: DriveUser, query: ListQuery): Promise<DriveAnswer> {
	const db = getDb(env);
	const folder = await getDriveItem(db, query.parentId!);
	const { role, chain } =
		folder?.kind === "folder" ? await getDriveRole(db, user.id, folder) : { role: null, chain: [] };
	if (!folder || !role) return notFound();
	// With a type filter files must match, but folders stay listed so you can still browse into them.
	const typeFilter = query.types.length
		? or(eq(driveItems.kind, "folder"), driveTypesCondition(query.types))
		: undefined;
	const { rows, nextCursor } = await page(db, [eq(driveItems.parentId, folder.id), visible, typeFilter], query.cursor);
	const path = role === "owner" ? chain : await trimToSharedRoot(db, user.id, chain);
	return ok({
		items: await toDriveItemDtos(db, rows, () => role),
		path: toDriveCrumbs(path),
		folder: { id: folder.id, name: folder.name, ownerId: folder.ownerId },
		role,
		nextCursor,
	});
}

async function listShared(env: CloudflareEnv, user: DriveUser, query: ListQuery): Promise<DriveAnswer> {
	const db = getDb(env);
	const typeFilter = query.types.length
		? or(eq(driveItems.kind, "folder"), driveTypesCondition(query.types))
		: undefined;
	const shared = sql`${driveItems.id} IN (SELECT ${driveShares.itemId} FROM ${driveShares} WHERE ${driveShares.userId} = ${user.id})`;
	const { rows, nextCursor } = await page(
		db,
		[shared, ne(driveItems.ownerId, user.id), visible, typeFilter],
		query.cursor,
	);
	const roles = new Map(
		(
			await db
				.select({ itemId: driveShares.itemId, role: driveShares.role })
				.from(driveShares)
				.where(eq(driveShares.userId, user.id))
		).map((share) => [share.itemId, share.role as DriveRole]),
	);
	const kept = await withoutTrashedAncestors(env, rows);
	return ok({
		items: await toDriveItemDtos(db, kept, (row) => roles.get(row.id) ?? "view"),
		path: [],
		role: "view",
		nextCursor,
	});
}

async function listTrash(env: CloudflareEnv, user: DriveUser, query: ListQuery): Promise<DriveAnswer> {
	const db = getDb(env);
	const typeFilter = query.types.length ? driveTypesCondition(query.types) : undefined;
	const { rows, nextCursor } = await page(
		db,
		[eq(driveItems.ownerId, user.id), isNotNull(driveItems.trashedAt), eq(driveItems.status, "ready"), typeFilter],
		query.cursor,
		driveItems.trashedAt,
	);
	return ok({ items: await toDriveItemDtos(db, rows, () => "owner"), path: [], role: "owner", nextCursor });
}

/** My Drive: the top level, or with a search or type filter every folder, files under a trashed folder left out. */
async function listMine(env: CloudflareEnv, user: DriveUser, query: ListQuery): Promise<DriveAnswer> {
	const db = getDb(env);
	const recent = query.view === "recent";
	const everywhere = recent || !!query.query || query.types.length > 0;
	const where: (SQL | undefined)[] = [eq(driveItems.ownerId, user.id), visible];
	if (query.query) where.push(sql`${driveItems.name} LIKE ${containsPattern(query.query)} ESCAPE '\\'`);
	if (query.types.length) where.push(eq(driveItems.kind, "file"), driveTypesCondition(query.types));
	if (recent) where.push(eq(driveItems.kind, "file"));
	if (!everywhere) where.push(isNull(driveItems.parentId));
	const { rows, nextCursor } = await page(db, where, query.cursor);
	const kept = everywhere ? await withoutTrashedAncestors(env, rows) : rows;
	return ok({ items: await toDriveItemDtos(db, kept, () => "owner"), path: [], role: "owner", nextCursor });
}

/** `GET /api/drive/items`: one page of a view, with the viewer's own usage. */
export async function listDriveItems(env: CloudflareEnv, user: DriveUser, query: ListQuery): Promise<DriveAnswer> {
	const answer = query.parentId
		? await listFolder(env, user, query)
		: query.view === "shared"
			? await listShared(env, user, query)
			: query.view === "trash"
				? await listTrash(env, user, query)
				: await listMine(env, user, query);
	if (answer.status !== 200) return answer;
	return ok({ ...answer.body, usage: await getDriveUsage(env, user.id) });
}

export const EMPTY_LISTING = { items: [], path: [], role: "owner", nextCursor: null, usage: { used: 0, limit: null } };
