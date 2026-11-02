import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { folders } from "@/db/schema";
import { requireSessionUser } from "@/lib/api/auth";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import type { SessionUser } from "@/lib/auth/types";
import { getEnv } from "@/lib/cloudflare";
import { deleteFolder, folderNameTaken, getFolderUsage, isUniqueNameError, updateFolder } from "@/lib/folders/manage";
import { RequestBodyTooLargeError } from "@/lib/http/errors";
import { readJsonBody } from "@/lib/http/request";
import { createAuditLog } from "@/lib/mailboxes/audit";
import { folderDeleteSchema, folderUpdateSchema } from "@/lib/validators";
import { getFolderForMailbox, getMailboxFolderAccess } from "../utils";
import type { FolderRouteParams } from "./types";

/** The folder if the caller can read its mailbox (404 otherwise, so ids do not leak) and whether they may change it. */
async function findFolder(env: CloudflareEnv, user: SessionUser, id: string) {
	const db = getDb(env);
	const [row] = await db.select({ mailboxId: folders.mailboxId }).from(folders).where(eq(folders.id, id)).limit(1);
	const access = row ? await getMailboxFolderAccess(db, user, row.mailboxId) : null;
	const folder = access ? await getFolderForMailbox(db, id, access.mailboxId) : null;
	return access && folder ? { db, folder, access } : null;
}

async function readBody(request: Request) {
	try {
		return { body: await readJsonBody<unknown>(request, 4 * 1024) };
	} catch (error) {
		return { status: error instanceof RequestBodyTooLargeError ? 413 : 400 };
	}
}

/** What deleting the folder would touch: its messages and rules, for the confirm dialog. */
export async function GET(request: Request, { params }: FolderRouteParams) {
	const { id } = await params;
	const env = getEnv();
	const { user, error } = await requireSessionUser(env, request);
	if (error) return error;
	const found = await findFolder(env, user, id);
	if (!found) return NextResponse.json({ error: "Folder not found" }, { status: 404 });
	const usage = await getFolderUsage(found.db, id, found.folder.mailboxId);
	return NextResponse.json({ id, mailboxId: found.folder.mailboxId, name: found.folder.name, ...usage });
}

export async function PATCH(request: Request, { params }: FolderRouteParams) {
	const { id } = await params;
	const env = getEnv();
	const { user, error } = await requireSessionUser(env, request);
	if (error) return error;
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
	const read = await readBody(request);
	if ("status" in read) return NextResponse.json({ error: "Invalid folder request" }, { status: read.status });
	const parsed = folderUpdateSchema.safeParse(read.body);
	if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

	const found = await findFolder(env, user, id);
	if (!found) return NextResponse.json({ error: "Folder not found" }, { status: 404 });
	if (!found.access.canManage) {
		return NextResponse.json({ error: "Full access to the mailbox is required" }, { status: 403 });
	}
	const { db, folder } = found;
	const { name, color } = parsed.data;
	const conflict = () => NextResponse.json({ error: "Folder already exists" }, { status: 409 });

	if (name !== undefined && name !== folder.name && (await folderNameTaken(db, folder.mailboxId, name, id))) {
		return conflict();
	}
	try {
		await updateFolder(db, id, folder.mailboxId, {
			...(name !== undefined && name !== folder.name ? { name } : {}),
			...(color !== undefined ? { color } : {}),
		});
	} catch (updateError) {
		// Another request took the name between the check and the write.
		if (isUniqueNameError(updateError)) return conflict();
		throw updateError;
	}

	const renamed = name !== undefined && name !== folder.name;
	await createAuditLog(env, {
		actorUserId: user.id,
		mailboxId: folder.mailboxId,
		action: "folder.rename",
		metadata: { folderId: id, ...(renamed ? { from: folder.name, to: name } : {}), ...(color ? { color } : {}) },
	});
	const updated = await getFolderForMailbox(db, id, folder.mailboxId);
	return NextResponse.json({
		id,
		mailboxId: folder.mailboxId,
		name: updated?.name ?? name ?? folder.name,
		color: updated?.color ?? color ?? folder.color,
		colorIsCustom: updated?.colorIsCustom ?? false,
	});
}

/**
 * Deletes a folder. A folder that holds mail needs `moveTo` ("inbox" or "archive"): the mail is moved out first,
 * then the folder goes, so nothing is lost. Inbox rules that file into it are turned off.
 */
export async function DELETE(request: Request, { params }: FolderRouteParams) {
	const { id } = await params;
	const env = getEnv();
	const { user, error } = await requireSessionUser(env, request);
	if (error) return error;
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
	const read = await readBody(request);
	if ("status" in read) return NextResponse.json({ error: "Invalid folder request" }, { status: read.status });
	const parsed = folderDeleteSchema.safeParse(read.body);
	if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

	const found = await findFolder(env, user, id);
	if (!found) return NextResponse.json({ error: "Folder not found" }, { status: 404 });
	if (!found.access.canManage) {
		return NextResponse.json({ error: "Full access to the mailbox is required" }, { status: 403 });
	}
	const { db, folder } = found;
	const outcome = await deleteFolder(db, id, folder.mailboxId, parsed.data.moveTo);
	if (!outcome.ok) {
		if (outcome.reason === "move_required") {
			return NextResponse.json(
				{
					error: "Choose where this folder's messages go",
					code: "FOLDER_MOVE_REQUIRED",
					messageCount: outcome.usage.messageCount,
				},
				{ status: 400 },
			);
		}
		if (outcome.reason === "import_active") {
			return NextResponse.json(
				{
					error: "An import is still filing mail into this folder. Cancel or finish it first.",
					code: "FOLDER_IMPORT_ACTIVE",
				},
				{ status: 409 },
			);
		}
		return NextResponse.json(
			{ error: "This folder is too large to empty in one go. Try again to continue.", code: "FOLDER_TOO_LARGE" },
			{ status: 503 },
		);
	}

	await createAuditLog(env, {
		actorUserId: user.id,
		mailboxId: folder.mailboxId,
		action: "folder.delete",
		metadata: {
			folderId: id,
			name: folder.name,
			moveTo: parsed.data.moveTo ?? null,
			messagesMoved: outcome.messagesMoved,
			rulesDisabled: outcome.rulesDisabled,
		},
	});
	return NextResponse.json({
		ok: true,
		id,
		mailboxId: folder.mailboxId,
		moveTo: parsed.data.moveTo ?? null,
		messagesMoved: outcome.messagesMoved,
		rulesDisabled: outcome.rulesDisabled,
	});
}
