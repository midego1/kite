import { and, eq, inArray } from "drizzle-orm";
import type { getDb } from "@/db";
import { users } from "@/db/schema";

type Db = ReturnType<typeof getDb>;

export async function validBookingHostIds(
	db: Db,
	ownerId: string,
	requested: string[],
	canManageHosts: boolean,
): Promise<string[] | null> {
	const hostIds = [ownerId, ...requested.filter((id) => id !== ownerId)];
	if (hostIds.length > 20 || (!canManageHosts && hostIds.length > 1)) return null;
	const active = await db
		.select({ id: users.id })
		.from(users)
		.where(and(inArray(users.id, hostIds), eq(users.disabled, false)));
	return active.length === hostIds.length ? hostIds : null;
}
