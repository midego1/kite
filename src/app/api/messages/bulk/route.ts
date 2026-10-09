import { and, eq, inArray } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { folders, messages } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { createAuditLogs } from "@/lib/mailboxes/audit";
import { queryInChunks, runInChunks } from "@/db/chunk-utils";
import type { MailboxAccessLevel } from "@/lib/mailboxes/types";
import { permanentlyDeleteMessages } from "@/lib/email/permanent-delete";
import { applySpamFeedback } from "@/lib/spam/feedback";
import type { BulkMessagePayload } from "./types";
import {
	getReadValueForBulkAction,
	getStatusForBulkAction,
	isAllowedBulkMessageAction,
	isPermanentlyDeletableStatus,
	isRestorableStatus,
	isUndoableBulkAction,
} from "./utils";

export async function POST(request: Request) {
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	const payload = (await request.json()) as BulkMessagePayload;
	const restoreStates =
		payload.action === "restore" && Array.isArray(payload.restore)
			? payload.restore.filter((state) => typeof state?.id === "string" && isRestorableStatus(state.status))
			: [];
	const messageIds =
		payload.action === "restore" ? restoreStates.map((state) => state.id) : (payload.messageIds?.filter(Boolean) ?? []);
	if (messageIds.length === 0 || !isAllowedBulkMessageAction(payload.action)) {
		return NextResponse.json({ error: "Invalid bulk message action" }, { status: 400 });
	}

	const status = getStatusForBulkAction(payload.action);
	const read = getReadValueForBulkAction(payload.action);
	const db = getDb(env);
	let folderId: string | null | undefined;

	if (payload.action === "folder") {
		if (!payload.folderId) {
			return NextResponse.json({ error: "Folder is required" }, { status: 400 });
		}
		const [folder] = await db
			.select({ id: folders.id, mailboxId: folders.mailboxId })
			.from(folders)
			.where(eq(folders.id, payload.folderId))
			.limit(1);
		if (!folder) {
			return NextResponse.json({ error: "Folder not found" }, { status: 404 });
		}
		const folderAccess = await getMailboxAccessLevel(db, user, folder.mailboxId);
		if (!folderAccess?.canManage) {
			return NextResponse.json({ error: "Folder not found" }, { status: 404 });
		}
		folderId = folder.id;
	} else if (
		payload.action === "spam" ||
		payload.action === "trash" ||
		payload.action === "inbox" ||
		payload.action === "archive"
	) {
		folderId = null;
	}

	const values = {
		...(status ? { status } : {}),
		...(read !== null ? { read } : {}),
		...(folderId !== undefined ? { folderId } : {}),
	};

	if (payload.action !== "delete" && payload.action !== "restore" && Object.keys(values).length === 0) {
		return NextResponse.json({ error: "No changes requested" }, { status: 400 });
	}

	const selectedMessages = await queryInChunks(messageIds, (ids) =>
		db
			.select({
				id: messages.id,
				mailboxId: messages.mailboxId,
				rawR2Key: messages.rawR2Key,
				status: messages.status,
				folderId: messages.folderId,
			})
			.from(messages)
			.where(inArray(messages.id, ids)),
	);
	const allowedMessageIds: string[] = [];
	// A bulk selection usually spans one or two mailboxes; resolve each once.
	const accessByMailbox = new Map<string, Promise<MailboxAccessLevel | null>>();

	for (const message of selectedMessages) {
		if (!message.mailboxId) continue;
		let accessRequest = accessByMailbox.get(message.mailboxId);
		if (!accessRequest) {
			accessRequest = getMailboxAccessLevel(db, user, message.mailboxId);
			accessByMailbox.set(message.mailboxId, accessRequest);
		}
		const access = await accessRequest;
		const canUpdate = payload.action === "read" || payload.action === "unread" ? access?.canRead : access?.canManage;
		if (!canUpdate) continue;
		allowedMessageIds.push(message.id);
	}

	if (allowedMessageIds.length === 0) {
		return NextResponse.json({ error: "No accessible messages" }, { status: 404 });
	}
	if (payload.action === "restore") {
		for (const state of restoreStates) {
			if (!allowedMessageIds.includes(state.id)) continue;
			const message = selectedMessages.find((candidate) => candidate.id === state.id);
			let restoredFolderId: string | null = null;
			if (state.folderId && message?.mailboxId) {
				const [folder] = await db
					.select({ id: folders.id })
					.from(folders)
					.where(and(eq(folders.id, state.folderId), eq(folders.mailboxId, message.mailboxId)))
					.limit(1);
				restoredFolderId = folder?.id ?? null;
			}
			await db
				.update(messages)
				.set({ status: state.status, folderId: restoredFolderId })
				.where(eq(messages.id, state.id));
		}
		return NextResponse.json({ ok: true });
	}
	if (payload.action === "delete") {
		// Only mail already in Trash or Spam can be destroyed; anything else is skipped.
		const deletable = selectedMessages.filter(
			(message) => allowedMessageIds.includes(message.id) && isPermanentlyDeletableStatus(message.status),
		);
		const deleted = await permanentlyDeleteMessages(env, db, user.id, deletable, "bulk");
		return NextResponse.json({ ok: true, deleted, skipped: allowedMessageIds.length - deleted });
	}
	if (payload.action === "spam") {
		for (const messageId of allowedMessageIds) await applySpamFeedback(env, user, messageId, "spam");
		return NextResponse.json({ ok: true });
	}
	if (payload.action === "inbox") {
		const spamMessageIds = selectedMessages
			.filter((message) => message.status === "spam" && allowedMessageIds.includes(message.id))
			.map((message) => message.id);
		const normalMessageIds = allowedMessageIds.filter((messageId) => !spamMessageIds.includes(messageId));
		for (const messageId of spamMessageIds) await applySpamFeedback(env, user, messageId, "ham");
		await runInChunks(normalMessageIds, (ids) => db.update(messages).set(values).where(inArray(messages.id, ids)));
		return NextResponse.json({ ok: true });
	}

	const undo = isUndoableBulkAction(payload.action)
		? selectedMessages
				.filter((message) => allowedMessageIds.includes(message.id) && isRestorableStatus(message.status))
				.map((message) => ({ id: message.id, status: message.status, folderId: message.folderId ?? null }))
		: undefined;
	await runInChunks(allowedMessageIds, (ids) => db.update(messages).set(values).where(inArray(messages.id, ids)));
	await createAuditLogs(
		env,
		allowedMessageIds.map((messageId) => ({
			actorUserId: user.id,
			messageId,
			action: payload.action === "read" || payload.action === "unread" ? "email.read" : "email.delete",
			metadata: { bulkAction: payload.action },
		})),
	);

	return NextResponse.json({ ok: true, ...(undo ? { undo } : {}) });
}
