import { and, gt, inArray, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { queryInChunks } from "@/db/chunk-utils";
import { users } from "@/db/schema";
import { driveLinks, driveShares } from "@/db/schema/drive";
import type { DriveItemDto, DriveRole, DriveRow } from "./types";

type Db = ReturnType<typeof getDb>;

/** Ids among `ids` that have a share or a live link, which the list shows as a "shared" marker. */
async function sharedItemIds(db: Db, ids: string[], now: Date): Promise<Set<string>> {
	const shared = await queryInChunks(ids, async (chunk) => {
		const [shares, links] = await Promise.all([
			db.select({ itemId: driveShares.itemId }).from(driveShares).where(inArray(driveShares.itemId, chunk)),
			db
				.select({ itemId: driveLinks.itemId })
				.from(driveLinks)
				.where(and(inArray(driveLinks.itemId, chunk), isNull(driveLinks.revokedAt), gt(driveLinks.expiresAt, now))),
		]);
		return [...shares, ...links].map((row) => row.itemId);
	});
	return new Set(shared);
}

function toDriveItemDto(row: DriveRow, role: DriveRole, ownerName: string, shared: boolean): DriveItemDto {
	return {
		id: row.id,
		kind: row.kind,
		name: row.name,
		size: row.size,
		contentType: row.contentType,
		parentId: row.parentId,
		ownerId: row.ownerId,
		ownerName,
		role,
		shared,
		trashedAt: row.trashedAt?.toISOString() ?? null,
		updatedAt: row.updatedAt.toISOString(),
	};
}

/** Rows as the client sees them: owner display names, the viewer's role, and whether each is shared. */
export async function toDriveItemDtos(
	db: Db,
	rows: DriveRow[],
	roleFor: (row: DriveRow) => DriveRole,
): Promise<DriveItemDto[]> {
	if (!rows.length) return [];
	const ownerIds = [...new Set(rows.map((row) => row.ownerId))];
	const owners = await queryInChunks(ownerIds, (chunk) =>
		db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(inArray(users.id, chunk)),
	);
	const ownerNames = new Map(owners.map((owner) => [owner.id, owner.name || owner.email]));
	const shared = await sharedItemIds(
		db,
		rows.map((row) => row.id),
		new Date(),
	);
	return rows.map((row) => toDriveItemDto(row, roleFor(row), ownerNames.get(row.ownerId) ?? "", shared.has(row.id)));
}
