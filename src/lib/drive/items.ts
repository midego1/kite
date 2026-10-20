import { inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { queryInChunks, runInChunks } from "@/db/chunk-utils";
import { driveItems } from "@/db/schema/drive";
import { newId } from "@/lib/ids";
import { deleteDriveItems, getDriveItem, getDriveRole, hiddenFolderIds, subtreeHeight } from "./access";
import { toDriveItemDtos } from "./dto";
import { DriveRefusal, fail, notFound, ok } from "./errors";
import { canEditDrive, DRIVE_MAX_DEPTH, normalizeDriveName, toDriveCrumbs } from "./name-utils";
import type { DriveAnswer, DriveRole, DriveRow, DriveUser } from "./types";

type Db = ReturnType<typeof getDb>;
const MAX_BULK_ITEMS = 100;
const BULK_ACTIONS = ["trash", "restore", "delete", "move"] as const;
type BulkAction = (typeof BULK_ACTIONS)[number];

/** A folder the user may add to, with its chain; refuses with 404 otherwise. */
export async function editableFolder(
	db: Db,
	userId: string,
	folderId: string,
): Promise<{ folder: DriveRow; chain: DriveRow[] }> {
	const folder = await getDriveItem(db, folderId);
	const { role, chain } =
		folder?.kind === "folder" ? await getDriveRole(db, userId, folder) : { role: null, chain: [] };
	if (!folder || !canEditDrive(role)) throw new DriveRefusal(404, "Folder not found");
	return { folder, chain };
}

export async function createFolder(env: CloudflareEnv, user: DriveUser, body: unknown): Promise<DriveAnswer> {
	const value = (body ?? {}) as { name?: unknown; parentId?: unknown };
	const name = normalizeDriveName(value.name);
	if (!name) return fail(400, "Enter a folder name");
	const db = getDb(env);
	let ownerId = user.id;
	let parentId: string | null = null;
	if (typeof value.parentId === "string" && value.parentId) {
		const { folder, chain } = await editableFolder(db, user.id, value.parentId);
		if (chain.length >= DRIVE_MAX_DEPTH) return fail(400, "Folders cannot be nested any deeper");
		parentId = folder.id;
		ownerId = folder.ownerId;
	}
	const now = new Date();
	const row: DriveRow = {
		id: newId("drv"),
		ownerId,
		parentId,
		kind: "folder",
		name,
		size: 0,
		contentType: "application/octet-stream",
		storeId: null,
		objectKey: null,
		status: "ready",
		uploadId: null,
		uploadPartSize: null,
		uploadFingerprint: null,
		uploadExpiresAt: null,
		sourceAttachmentId: null,
		trashedAt: null,
		createdAt: now,
		updatedAt: now,
	};
	await db.insert(driveItems).values(row);
	const [item] = await toDriveItemDtos(db, [row], () => (ownerId === user.id ? "owner" : "edit"));
	return ok({ item }, 201);
}

/** An item the user can see, with the role and breadcrumb; the owner also sees it while it is in the trash. */
export async function getItemDetails(env: CloudflareEnv, user: DriveUser, id: string): Promise<DriveAnswer> {
	const db = getDb(env);
	const item = await getDriveItem(db, id);
	if (!item) return notFound();
	const { role, chain } = await getDriveRole(db, user.id, item, { allowTrashed: item.ownerId === user.id });
	if (!role) return notFound();
	const [dto] = await toDriveItemDtos(db, [item], () => role);
	return ok({ item: dto, role, path: toDriveCrumbs(role === "owner" ? chain : chain.slice(-1)) });
}

/**
 * Checks that every row may move into `parentId` (null is the owner's top level). Editors move only within
 * the owner's folders they can edit, so they can never take an item out of what was shared; nothing moves
 * into itself, across owners, or deeper than the nesting limit.
 */
async function checkMove(
	env: CloudflareEnv,
	user: DriveUser,
	rows: DriveRow[],
	parentId: string | null,
): Promise<void> {
	const db = getDb(env);
	const destination = parentId ? await editableFolder(db, user.id, parentId) : null;
	const ancestors = new Set(destination?.chain.map((entry) => entry.id) ?? []);
	for (const row of rows) {
		if (!destination && row.ownerId !== user.id)
			throw new DriveRefusal(403, "Only the owner can move items out of a shared folder");
		if (destination && destination.folder.ownerId !== row.ownerId)
			throw new DriveRefusal(400, "Items can only move within the same owner's Drive");
		if (ancestors.has(row.id)) throw new DriveRefusal(400, "A folder cannot move into itself");
		const depth = (destination?.chain.length ?? 0) + 1 + (row.kind === "folder" ? await subtreeHeight(env, row.id) : 0);
		if (depth > DRIVE_MAX_DEPTH) throw new DriveRefusal(400, "Folders cannot be nested any deeper");
	}
}

async function roleOf(db: Db, user: DriveUser, row: DriveRow, allowTrashed = false): Promise<DriveRole | null> {
	return (await getDriveRole(db, user.id, row, { allowTrashed })).role;
}

/** `PATCH /api/drive/items/[id]`: `{ name?, parentId? }`. */
export async function updateItem(env: CloudflareEnv, user: DriveUser, id: string, body: unknown): Promise<DriveAnswer> {
	const value = (body ?? {}) as { name?: unknown; parentId?: unknown };
	const db = getDb(env);
	const item = await getDriveItem(db, id);
	const role = item ? await roleOf(db, user, item) : null;
	if (!item || !canEditDrive(role)) return notFound();
	const patch: Partial<DriveRow> = { updatedAt: new Date() };
	if (value.name !== undefined) {
		const name = normalizeDriveName(value.name);
		if (!name) return fail(400, "Enter a name");
		patch.name = name;
	}
	if (value.parentId !== undefined) {
		if (value.parentId !== null && typeof value.parentId !== "string") return fail(400, "Invalid folder");
		const parentId = value.parentId || null;
		await checkMove(env, user, [item], parentId);
		patch.parentId = parentId;
	}
	await db
		.update(driveItems)
		.set(patch)
		.where(inArray(driveItems.id, [item.id]));
	const [dto] = await toDriveItemDtos(db, [{ ...item, ...patch }], () => role!);
	return ok({ item: dto });
}

/** `DELETE /api/drive/items/[id]`: forever, for the owner, and only from the trash. */
export async function deleteItemForever(env: CloudflareEnv, user: DriveUser, id: string): Promise<DriveAnswer> {
	const item = await getDriveItem(getDb(env), id);
	if (!item || item.ownerId !== user.id || item.status !== "ready") return notFound();
	if (!item.trashedAt) return fail(409, "Move the item to the trash first");
	return ok({ count: await deleteDriveItems(env, [item]) });
}

function parseBulk(body: unknown): { ids: string[]; action: BulkAction; parentId: string | null } | { error: string } {
	const value = (body ?? {}) as { ids?: unknown; action?: unknown; parentId?: unknown };
	const ids = Array.isArray(value.ids)
		? [...new Set(value.ids.filter((id): id is string => typeof id === "string"))]
		: [];
	if (!ids.length || ids.length > MAX_BULK_ITEMS) return { error: `Select between 1 and ${MAX_BULK_ITEMS} items` };
	if (!BULK_ACTIONS.includes(value.action as BulkAction)) return { error: "Unknown action" };
	if (value.parentId !== undefined && value.parentId !== null && typeof value.parentId !== "string")
		return { error: "Invalid folder" };
	return { ids, action: value.action as BulkAction, parentId: (value.parentId as string | null | undefined) || null };
}

/** Whether the user may apply the action to the row: trash needs edit rights, everything else ownership. */
async function mayApply(db: Db, user: DriveUser, row: DriveRow, action: BulkAction): Promise<boolean> {
	if (row.status !== "ready") return false;
	if (action === "trash") return canEditDrive(await roleOf(db, user, row));
	if (action === "move" && row.ownerId !== user.id) return canEditDrive(await roleOf(db, user, row));
	return row.ownerId === user.id;
}

/** Restores rows; one whose folder is itself in the trash (or gone) comes back at the top level instead of staying hidden. */
async function restoreRows(
	env: CloudflareEnv,
	rows: DriveRow[],
	update: (targets: DriveRow[], set: Partial<DriveRow>) => Promise<DriveAnswer>,
): Promise<DriveAnswer> {
	const parentIds = rows.flatMap((row) => (row.parentId ? [row.parentId] : []));
	const hidden = await hiddenFolderIds(env, parentIds);
	const present = new Set(
		(
			await queryInChunks(parentIds, (chunk) =>
				getDb(env).select({ id: driveItems.id }).from(driveItems).where(inArray(driveItems.id, chunk)),
			)
		).map((row) => row.id),
	);
	const restoring = new Set(rows.map((row) => row.id));
	const orphaned = rows.filter(
		(row) => row.parentId && !restoring.has(row.parentId) && (hidden.has(row.parentId) || !present.has(row.parentId)),
	);
	const inPlace = rows.filter((row) => !orphaned.includes(row));
	await update(orphaned, { trashedAt: null, parentId: null });
	await update(inPlace, { trashedAt: null });
	return ok({ count: rows.length });
}

/**
 * `POST /api/drive/items/bulk`: trash, restore, delete (forever, trashed items only) or move. Moving a
 * trashed item also takes it out of the trash, so it can be dragged from Trash straight into a folder.
 */
export async function bulkItems(env: CloudflareEnv, user: DriveUser, body: unknown): Promise<DriveAnswer> {
	const parsed = parseBulk(body);
	if ("error" in parsed) return fail(400, parsed.error);
	const db = getDb(env);
	const rows = await queryInChunks(parsed.ids, (chunk) =>
		db.select().from(driveItems).where(inArray(driveItems.id, chunk)),
	);
	if (rows.length !== parsed.ids.length) return notFound();
	for (const row of rows) if (!(await mayApply(db, user, row, parsed.action))) return notFound();
	const now = new Date();
	const update = async (targets: DriveRow[], set: Partial<DriveRow>) => {
		await runInChunks(
			targets.map((row) => row.id),
			(chunk) =>
				db
					.update(driveItems)
					.set({ ...set, updatedAt: now })
					.where(inArray(driveItems.id, chunk)),
		);
		return ok({ count: targets.length });
	};
	if (parsed.action === "trash")
		return update(
			rows.filter((row) => !row.trashedAt),
			{ trashedAt: now },
		);
	if (parsed.action === "restore")
		return restoreRows(
			env,
			rows.filter((row) => row.trashedAt),
			update,
		);
	if (parsed.action === "delete")
		return ok({
			count: await deleteDriveItems(
				env,
				rows.filter((row) => row.trashedAt),
			),
		});
	await checkMove(env, user, rows, parsed.parentId);
	return update(
		rows.filter((row) => row.parentId !== parsed.parentId || row.trashedAt),
		{ parentId: parsed.parentId, trashedAt: null },
	);
}
