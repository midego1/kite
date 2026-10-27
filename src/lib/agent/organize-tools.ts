import { and, asc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { folders, messages } from "@/db/schema";
import { DEFAULT_FOLDER_COLOR } from "@/lib/folders/colors";
import { newId } from "@/lib/ids";
import { createAuditLog, createAuditLogs } from "@/lib/mailboxes/audit";
import { updateMessageStatusForUser } from "@/lib/user";
import { FOLDER_COLOR_NAMES, folderColorValue } from "./organize-tools-utils";
import { ownMessage, publicMessage, requireAccess } from "./tool-messages";
import type { AgentToolContext, EmailToolName } from "./types";

type Input = Record<string, unknown>;
type MessageRow = typeof messages.$inferSelect;

/** The tools that change where mail is filed or whether it is read, plus the folder tools. */
const ORGANIZE_TOOL_NAMES = [
	"mark_email_read",
	"mark_emails_read",
	"mark_emails_unread",
	"move_email",
	"move_emails",
	"list_folders",
	"create_folder",
	"move_emails_to_folder",
] as const satisfies readonly EmailToolName[];

type OrganizeToolName = (typeof ORGANIZE_TOOL_NAMES)[number];

export function isOrganizeTool(name: EmailToolName): name is OrganizeToolName {
	return (ORGANIZE_TOOL_NAMES as readonly string[]).includes(name);
}

/** The messages named by the ids, each readable by the user in the selected mailbox; repeated ids count once. */
async function ownMessages(context: AgentToolContext, ids: readonly string[]): Promise<MessageRow[]> {
	return Promise.all([...new Set(ids)].map((messageId) => ownMessage(context, messageId)));
}

function refuseUnmovable(rows: readonly MessageRow[]) {
	if (rows.some((row) => row.status === "draft" || row.status === "sent")) throw new Error("Cannot move this message");
}

async function setRead(context: AgentToolContext, rows: readonly MessageRow[], read: boolean) {
	await getDb(context.env)
		.update(messages)
		.set({ read })
		.where(
			and(
				eq(messages.mailboxId, context.mailboxId),
				inArray(
					messages.id,
					rows.map((row) => row.id),
				),
			),
		);
	await createAuditLogs(
		context.env,
		rows.map((row) => ({
			actorUserId: context.user.id,
			mailboxId: context.mailboxId,
			messageId: row.id,
			action: "email.read",
			metadata: { read },
		})),
	);
}

/** `mark_email_read` keeps its single-email shape, so proposals saved before the bulk tools still approve. */
async function markEmailRead(context: AgentToolContext, input: Input) {
	const row = await ownMessage(context, input.emailId as string);
	const read = input.read as boolean;
	if (context.origin === "chat")
		return {
			action: "mark_email_read",
			status: "pending_approval",
			emailId: row.id,
			read,
			emails: [publicMessage(row)],
		};
	await setRead(context, [row], read);
	return { emailId: row.id, read };
}

async function markEmails(context: AgentToolContext, name: "mark_emails_read" | "mark_emails_unread", input: Input) {
	const rows = await ownMessages(context, input.emailIds as string[]);
	const read = name === "mark_emails_read";
	const emailIds = rows.map((row) => row.id);
	if (context.origin === "chat")
		return { action: name, status: "pending_approval", emailIds, read, emails: rows.map(publicMessage) };
	await setRead(context, rows, read);
	return { emailIds, read, status: "approved" };
}

async function moveEmails(context: AgentToolContext, name: "move_email" | "move_emails", input: Input) {
	await requireAccess(context, false, true);
	const ids = name === "move_email" ? [input.emailId as string] : [...new Set(input.emailIds as string[])];
	const rows = await ownMessages(context, ids);
	refuseUnmovable(rows);
	const destination = input.destination as string;
	if (context.origin === "chat")
		return { action: name, status: "pending_approval", emailIds: ids, destination, emails: rows.map(publicMessage) };
	for (const row of rows) {
		const moved = await updateMessageStatusForUser(
			context.env,
			context.user,
			row.id,
			destination === "inbox" ? "received" : destination,
			context.onReceipt,
		);
		if (!moved) throw new Error("Message could not be moved");
	}
	return { emailIds: ids, destination, status: "approved" };
}

async function listFolders(context: AgentToolContext) {
	await requireAccess(context);
	const rows = await getDb(context.env)
		.select({ id: folders.id, name: folders.name, color: folders.color })
		.from(folders)
		.where(eq(folders.mailboxId, context.mailboxId))
		.orderBy(asc(folders.name));
	return { folders: rows.map((row) => ({ ...row, url: `/folders/${encodeURIComponent(row.id)}` })) };
}

async function folderNamed(context: AgentToolContext, name: string) {
	const [row] = await getDb(context.env)
		.select({ id: folders.id })
		.from(folders)
		.where(and(eq(folders.mailboxId, context.mailboxId), eq(folders.name, name)))
		.limit(1);
	return row ?? null;
}

async function createFolder(context: AgentToolContext, input: Input) {
	const access = await requireAccess(context, false, true);
	const name = (input.name as string).trim();
	const colorName = (input.color as string | undefined) ?? FOLDER_COLOR_NAMES[0];
	const color = folderColorValue(colorName) ?? DEFAULT_FOLDER_COLOR;
	const existing = await folderNamed(context, name);
	if (existing) throw new Error(`A folder named "${name}" already exists; its folderId is ${existing.id}`);
	// The proposal keeps the colour's name, which is what approving passes back to this tool.
	if (context.origin === "chat") return { action: "create_folder", status: "pending_approval", name, color: colorName };
	const folderId = context.folderId ?? newId("fld");
	try {
		await getDb(context.env).insert(folders).values({
			id: folderId,
			userId: access.mailbox.userId,
			mailboxId: context.mailboxId,
			name,
			color,
		});
	} catch (error) {
		// Another request created the same name since the check above; the unique index refused this one.
		if (/unique/i.test(error instanceof Error ? `${error.message} ${String(error.cause ?? "")}` : String(error)))
			throw new Error(`A folder named "${name}" already exists`);
		throw error;
	}
	await createAuditLog(context.env, {
		actorUserId: context.user.id,
		mailboxId: context.mailboxId,
		action: "folder.create",
		metadata: { folderId, name, origin: context.origin },
	});
	return { folderId, name, color, status: "created", url: `/folders/${encodeURIComponent(folderId)}` };
}

async function moveEmailsToFolder(context: AgentToolContext, input: Input) {
	await requireAccess(context, false, true);
	const db = getDb(context.env);
	const [folder] = await db
		.select({ id: folders.id, name: folders.name })
		.from(folders)
		.where(and(eq(folders.id, input.folderId as string), eq(folders.mailboxId, context.mailboxId)))
		.limit(1);
	if (!folder) throw new Error("Folder not found in this mailbox; use list_folders for its folderId");
	const rows = await ownMessages(context, input.emailIds as string[]);
	refuseUnmovable(rows);
	const emailIds = rows.map((row) => row.id);
	if (context.origin === "chat")
		return {
			action: "move_emails_to_folder",
			status: "pending_approval",
			emailIds,
			folderId: folder.id,
			folderName: folder.name,
			emails: rows.map(publicMessage),
		};
	// The same change as the bulk "Move to folder" action: a filed message is received mail in that folder.
	await db
		.update(messages)
		.set({ folderId: folder.id, status: "received" })
		.where(and(eq(messages.mailboxId, context.mailboxId), inArray(messages.id, emailIds)));
	await createAuditLogs(
		context.env,
		rows.map((row) => ({
			actorUserId: context.user.id,
			mailboxId: context.mailboxId,
			messageId: row.id,
			action: "email.delete",
			metadata: { bulkAction: "folder", folderId: folder.id },
		})),
	);
	return { emailIds, folderId: folder.id, folderName: folder.name, status: "approved" };
}

export async function runOrganizeTool(context: AgentToolContext, name: OrganizeToolName, input: Input) {
	if (name === "mark_email_read") return markEmailRead(context, input);
	if (name === "mark_emails_read" || name === "mark_emails_unread") return markEmails(context, name, input);
	if (name === "move_email" || name === "move_emails") return moveEmails(context, name, input);
	if (name === "list_folders") return listFolders(context);
	if (name === "create_folder") return createFolder(context, input);
	return moveEmailsToFolder(context, input);
}
