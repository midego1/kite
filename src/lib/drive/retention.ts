import { and, eq, isNotNull, lte, or, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { driveItems } from "@/db/schema/drive";
import { deleteDriveItems } from "./access";
import { driveTablesReady } from "./errors";
import { getDriveSettings } from "./quota";
import { trashCutoff } from "./settings-utils";
import { DRIVE_UPLOAD_RESUME_MS } from "./upload-utils";

const BATCH_SIZE = 100;
const MAX_PASSES = 20;

export type PurgeResult = { trashed: number; uploads: number };

/**
 * The daily Drive job: deletes items that have been in the trash longer than the retention (rows and
 * stored objects, with everything inside a folder), and aborts uploads nobody finished in time. Passes
 * repeat until nothing is left, up to a cap, so a large backlog clears in one run.
 */
export async function purgeDrive(env: CloudflareEnv, now = new Date()): Promise<PurgeResult> {
	if (!(await driveTablesReady(env))) return { trashed: 0, uploads: 0 };
	const db = getDb(env);
	const cutoff = trashCutoff(now, (await getDriveSettings(env)).trashRetentionDays);
	const staleUpload = new Date(now.getTime() - DRIVE_UPLOAD_RESUME_MS);
	const result: PurgeResult = { trashed: 0, uploads: 0 };
	for (let pass = 0; pass < MAX_PASSES; pass += 1) {
		const trashed = await db
			.select()
			.from(driveItems)
			.where(and(isNotNull(driveItems.trashedAt), lte(driveItems.trashedAt, cutoff)))
			.limit(BATCH_SIZE);
		const uploads = await db
			.select()
			.from(driveItems)
			.where(
				and(
					eq(driveItems.status, "uploading"),
					or(
						lte(driveItems.uploadExpiresAt, now),
						and(isNull(driveItems.uploadExpiresAt), lte(driveItems.createdAt, staleUpload)),
					),
				),
			)
			.limit(BATCH_SIZE);
		if (trashed.length) result.trashed += await deleteDriveItems(env, trashed);
		if (uploads.length) result.uploads += await deleteDriveItems(env, uploads);
		if (trashed.length < BATCH_SIZE && uploads.length < BATCH_SIZE) break;
	}
	return result;
}
