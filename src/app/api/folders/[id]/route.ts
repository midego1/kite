import { eq } from "drizzle-orm";
import type { ZodType } from "zod";
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

/**
 * What PATCH and DELETE share: the session, the CSRF origin check, the parsed body and the folder, which the caller
 * must be allowed to change (full access to its mailbox). Anything else is the response to send.
 */
async function prepareMutation<T>(
	request: Request,
	{ params }: FolderRouteParams,
	schema: ZodType<T>,
): Promise<
	| { response: NextResponse }
	| {
			env: CloudflareEnv;
			user: SessionUser;
			data: T;
			found: NonNullable<Awaited<ReturnType<typeof findFolder>>>;
			id: string;
	  }
> {
	const { id } = await params;
	const env = getEnv();
	const { user, error } = await requireSessionUser(env, request);
	if (error) return { response: error };
	if (!hasValidSessionMutationOrigin(request)) {
		return { response: NextResponse.json({ error: "Invalid origin" }, { status: 403 }) };
	}
	const read = await readBody(request);
	if ("status" in read) {
		return { response: NextResponse.json({ error: "Invalid folder request" }, { status: read.status }) };
	}
	const parsed = schema.safeParse(read.body);
	if (!parsed.success) return { response: NextResponse.json({ error: parsed.error.flatten() }, { status: 400 }) };
	const found = await findFolder(env, user, id);
	if (!found) return { response: NextResponse.json({ error: "Folder not found" }, { status: 404 }) };
	if (!found.access.canManage) {
		return { response: NextResponse.json({ error: "Full access to the mailbox is required" }, { status: 403 }) };
	}
	return { env, user, data: parsed.data, found, id };
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

export async function PATCH(request: Request, context: FolderRouteParams) {
	const prepared = await prepareMutation(request, context, folderUpdateSchema);
	if ("response" in prepared) return prepared.response;
	const { env, user, found, id, data } = prepared;
	const { db, folder } = found;
	const { color } = data;
	// Sending the folder's own name back is not a rename.
	const name = data.name !== folder.name ? data.name : undefined;
	const conflict = () => NextResponse.json({ error: "Folder already exists" }, { status: 409 });

	if (name && (await folderNameTaken(db, folder.mailboxId, name, id))) return conflict();
	try {
		await updateFolder(db, id, folder.mailboxId, { name, color });
	} catch (updateError) {
		// Another request took the name between the check and the write.
		if (isUniqueNameError(updateError)) return conflict();
		throw updateError;
	}

	await createAuditLog(env, {
		actorUserId: user.id,
		mailboxId: folder.mailboxId,
		action: "folder.rename",
		metadata: { folderId: id, ...(name ? { from: folder.name, to: name } : {}), ...(color ? { color } : {}) },
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
export async function DELETE(request: Request, context: FolderRouteParams) {
	const prepared = await prepareMutation(request, context, folderDeleteSchema);
	if ("response" in prepared) return prepared.response;
	const { env, user, found, id, data } = prepared;
	const { db, folder } = found;
	const outcome = await deleteFolder(db, id, folder.mailboxId, data.moveTo);
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
			moveTo: data.moveTo ?? null,
			messagesMoved: outcome.messagesMoved,
			rulesDisabled: outcome.rulesDisabled,
		},
	});
	return NextResponse.json({
		ok: true,
		id,
		mailboxId: folder.mailboxId,
		moveTo: data.moveTo ?? null,
		messagesMoved: outcome.messagesMoved,
		rulesDisabled: outcome.rulesDisabled,
	});
}
