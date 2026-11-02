import { and, count, eq, inArray, ne, sql } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { folders, messages, routingRules } from "@/db/schema";
import { importJobFolders, importJobs } from "@/db/schema/import-jobs";
import { missingColumnFromError } from "@/lib/auth/user-lookup-utils";
import type { FolderColor } from "./types";
import type { FolderDeleteResult, FolderMoveTarget, FolderUsage } from "./manage-types";
import { FOLDER_MOVE_BATCH_SIZE, FOLDER_MOVE_MAX_BATCHES } from "./manage-utils";

const ACTIVE_IMPORT_STATUSES = ["pending", "running", "paused"] as const;
const ACTIVE_IMPORT_FOLDER_STATUSES = ["pending", "running"] as const;

/** Import jobs still filing mail into a folder; the tables are missing before migration 0076 (then none). */
async function countActiveImports(db: AppDatabase, folderId: string, mailboxId: string): Promise<number> {
	const destination = `folder:${folderId}`;
	try {
		const [single] = await db
			.select({ n: count() })
			.from(importJobs)
			.where(
				and(
					eq(importJobs.mailboxId, mailboxId),
					eq(importJobs.destination, destination),
					inArray(importJobs.status, [...ACTIVE_IMPORT_STATUSES]),
				),
			);
		const [perFolder] = await db
			.select({ n: count() })
			.from(importJobFolders)
			.innerJoin(importJobs, eq(importJobs.id, importJobFolders.jobId))
			.where(
				and(
					eq(importJobs.mailboxId, mailboxId),
					eq(importJobFolders.destination, destination),
					inArray(importJobFolders.status, [...ACTIVE_IMPORT_FOLDER_STATUSES]),
					inArray(importJobs.status, [...ACTIVE_IMPORT_STATUSES]),
				),
			);
		return (single?.n ?? 0) + (perFolder?.n ?? 0);
	} catch (error) {
		if (/no such (table|column)/i.test(String((error as Error)?.message ?? error))) return 0;
		throw error;
	}
}

export async function getFolderUsage(db: AppDatabase, folderId: string, mailboxId: string): Promise<FolderUsage> {
	const [mail] = await db
		.select({ n: count() })
		.from(messages)
		.where(and(eq(messages.folderId, folderId), eq(messages.mailboxId, mailboxId)));
	const [rules] = await db.select({ n: count() }).from(routingRules).where(eq(routingRules.folderId, folderId));
	return {
		messageCount: mail?.n ?? 0,
		ruleCount: rules?.n ?? 0,
		activeImports: await countActiveImports(db, folderId, mailboxId),
	};
}

/** Whether another folder of the mailbox already has this exact name (the unique index compares exactly). */
export async function folderNameTaken(db: AppDatabase, mailboxId: string, name: string, exceptId: string) {
	const [row] = await db
		.select({ id: folders.id })
		.from(folders)
		.where(and(eq(folders.mailboxId, mailboxId), eq(folders.name, name), ne(folders.id, exceptId)))
		.limit(1);
	return !!row;
}

export function isUniqueNameError(error: unknown): boolean {
	const cause = (error as { cause?: unknown })?.cause;
	return /UNIQUE constraint failed/i.test(`${error} ${cause}`);
}

/**
 * Renames and/or recolours a folder. Choosing a colour marks it as picked; before migration 0086 adds
 * `color_is_custom` the colour is stored without the flag, as `insertFolder` does.
 */
export async function updateFolder(
	db: AppDatabase,
	folderId: string,
	mailboxId: string,
	patch: { name?: string; color?: FolderColor },
): Promise<void> {
	const where = and(eq(folders.id, folderId), eq(folders.mailboxId, mailboxId));
	const values = {
		...(patch.name !== undefined ? { name: patch.name } : {}),
		...(patch.color !== undefined ? { color: patch.color } : {}),
	};
	// Nothing to write when the name is sent unchanged.
	if (Object.keys(values).length === 0) return;
	try {
		await db
			.update(folders)
			.set({ ...values, ...(patch.color !== undefined ? { colorIsCustom: true } : {}) })
			.where(where);
	} catch (error) {
		if (missingColumnFromError(error) !== "color_is_custom") throw error;
		await db.update(folders).set(values).where(where);
	}
}

/**
 * Takes every message out of a folder in bounded batches. Each statement binds the folder, the mailbox and the batch
 * size only (D1 refuses more than 100 bound values), so a folder of any size is moved by repeating it; clearing
 * `folder_id` is what makes the next batch pick up new rows. Archive moves only mail still in the inbox state
 * (`received`); anything already in Spam, Trash, Sent or the Screener keeps its status and only leaves the folder.
 * Resolves false when the batch limit was reached before the folder emptied.
 */
export async function moveFolderMessages(
	db: AppDatabase,
	folderId: string,
	mailboxId: string,
	moveTo: FolderMoveTarget,
): Promise<boolean> {
	const inFolder = and(eq(messages.folderId, folderId), eq(messages.mailboxId, mailboxId));
	for (let batch = 0; batch < FOLDER_MOVE_MAX_BATCHES; batch++) {
		const ids = db.select({ id: messages.id }).from(messages).where(inFolder).limit(FOLDER_MOVE_BATCH_SIZE);
		await db
			.update(messages)
			.set({
				folderId: null,
				...(moveTo === "archive"
					? { status: sql`case when ${messages.status} = 'received' then 'archived' else ${messages.status} end` }
					: {}),
			})
			.where(inArray(messages.id, ids));
		const [left] = await db.select({ id: messages.id }).from(messages).where(inFolder).limit(1);
		if (!left) return true;
	}
	return false;
}

/**
 * Turns off every inbox rule that files mail into the folder, so none is left pointing at nothing (the foreign key
 * clears its folder when the row goes, and a rule without a folder is skipped). Resolves how many were still on.
 */
export async function disableFolderRules(db: AppDatabase, folderId: string): Promise<number> {
	const [on] = await db
		.select({ n: count() })
		.from(routingRules)
		.where(and(eq(routingRules.folderId, folderId), eq(routingRules.enabled, true)));
	await db.update(routingRules).set({ enabled: false }).where(eq(routingRules.folderId, folderId));
	return on?.n ?? 0;
}

export type DeleteFolderOutcome =
	| ({ ok: true } & FolderDeleteResult)
	| { ok: false; reason: "move_required" | "import_active" | "too_large"; usage: FolderUsage };

/**
 * Deletes a folder without losing mail. The rules go off first and the messages leave before the row is removed,
 * so a failure part-way leaves a folder that is simply emptier, and repeating the request finishes the job.
 */
export async function deleteFolder(
	db: AppDatabase,
	folderId: string,
	mailboxId: string,
	moveTo: FolderMoveTarget | undefined,
): Promise<DeleteFolderOutcome> {
	const usage = await getFolderUsage(db, folderId, mailboxId);
	if (usage.activeImports > 0) return { ok: false, reason: "import_active", usage };
	if (usage.messageCount > 0 && !moveTo) return { ok: false, reason: "move_required", usage };

	const rulesDisabled = await disableFolderRules(db, folderId);
	if (moveTo && !(await moveFolderMessages(db, folderId, mailboxId, moveTo))) {
		return { ok: false, reason: "too_large", usage };
	}
	await db.delete(folders).where(and(eq(folders.id, folderId), eq(folders.mailboxId, mailboxId)));
	return { ok: true, messagesMoved: moveTo ? usage.messageCount : 0, rulesDisabled };
}
