import { eq, sql } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { userPreferences } from "@/db/schema/user-preferences";
import { isNoSuchTableError } from "@/lib/modules/state-utils";
import type { LayoutPreferences, LayoutPreferencesResponse } from "./layout-types";
import { parseStoredLayout } from "./layout-utils";

/** Saving before migration 0080 is applied; the route answers 409 `MIGRATION_PENDING`. */
export class LayoutPreferencesPendingError extends Error {
	constructor() {
		super("Apply the pending database update first");
		this.name = "LayoutPreferencesPendingError";
	}
}

/** The account's saved layout; before migration 0080 it reads as not ready, so browsers keep their own. */
export async function readLayoutPreferences(db: AppDatabase, userId: string): Promise<LayoutPreferencesResponse> {
	try {
		const [row] = await db
			.select({ layout: userPreferences.layout })
			.from(userPreferences)
			.where(eq(userPreferences.userId, userId))
			.limit(1);
		return { ready: true, layout: row ? parseStoredLayout(row.layout) : null };
	} catch (error) {
		if (!isNoSuchTableError(error)) throw error;
		return { ready: false, layout: null };
	}
}

/**
 * Merges the changed choices into the saved layout in one statement (`json_patch`), so two tabs saving
 * different choices at once both keep theirs. Throws `LayoutPreferencesPendingError` before migration 0080.
 */
export async function saveLayoutPreferences(
	db: AppDatabase,
	userId: string,
	patch: LayoutPreferences,
): Promise<LayoutPreferences> {
	const json = JSON.stringify(patch);
	const now = new Date();
	try {
		const [row] = await db
			.insert(userPreferences)
			.values({ userId, layout: json, updatedAt: now })
			.onConflictDoUpdate({
				target: userPreferences.userId,
				set: { layout: sql`json_patch(${userPreferences.layout}, ${json})`, updatedAt: now },
			})
			.returning({ layout: userPreferences.layout });
		return parseStoredLayout(row?.layout);
	} catch (error) {
		if (isNoSuchTableError(error)) throw new LayoutPreferencesPendingError();
		throw error;
	}
}
