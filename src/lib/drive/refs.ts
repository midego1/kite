import { inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { driveItems } from "@/db/schema/drive";
import { getEnv } from "@/lib/cloudflare";
import {
	forEachIdChunk,
	idsOfKind,
	refKey,
	refsOf,
	refsOutput,
	viewerId,
	type FoundRef,
} from "@/lib/modules/handler-helpers";
import type { CapabilityHandler } from "@/lib/modules/module-types";
import { isNoSuchTableError } from "@/lib/modules/state-utils";
import { getDriveRole } from "./access";
import { driveTablesReady } from "./errors";
import { driveItemHref } from "./name-utils";

const KIND = "drive:file";

/**
 * A Drive item is visible to whoever has a role on it (owner, or a share on it or a folder above it);
 * trashed items and uploads in progress read as unavailable, and so does everything before migration 0064.
 */
export const resolveDriveRefs: CapabilityHandler = async (input, ctx) => {
	const refs = refsOf(input);
	const userId = viewerId(ctx);
	const found = new Map<string, FoundRef>();
	const ids = idsOfKind(refs, KIND);
	const env = getEnv();
	if (!userId || ids.length === 0 || !(await driveTablesReady(env))) return refsOutput(refs, found);
	const db = getDb(env);
	try {
		await forEachIdChunk(ids, async (chunk) => {
			const rows = await db.select().from(driveItems).where(inArray(driveItems.id, chunk));
			for (const row of rows) {
				const { role } = await getDriveRole(db, userId, row);
				if (role) found.set(refKey(KIND, row.id), { href: driveItemHref(row), label: row.name });
			}
		});
	} catch (error) {
		if (!isNoSuchTableError(error)) throw error;
		found.clear();
	}
	return refsOutput(refs, found);
};
