import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import type { AppDatabase } from "@/db";
import { messages } from "@/db/schema";
import { deleteMessageWithObjects } from "@/lib/email/message-cleanup";
import { isHiddenDraft } from "@/lib/messages/draft-privacy-utils";
import type { BulkMessageAction, MessageRestoreState } from "./types";
import { bulkDraftHandling } from "./utils";

type SelectedMessage = {
	id: string;
	mailboxId: string | null;
	rawR2Key: string | null;
	status: string;
	userId: string;
};

export type SettledDrafts<T> = { rest: T[]; deleted: number; refused: number };

/**
 * Takes drafts out of a bulk selection before the usual access checks. Another user's draft is private, so
 * it is treated as if it did not exist. The caller's own drafts are deleted outright (with their objects)
 * by Delete and Trash, as the composer's Discard does, and left alone by any other move; so are moves that
 * would turn a message into a draft. Everything else is returned in `rest`.
 */
export async function settleDrafts<T extends SelectedMessage>(
	env: CloudflareEnv,
	db: AppDatabase,
	userId: string,
	action: BulkMessageAction,
	selected: readonly T[],
	restore: readonly MessageRestoreState[],
): Promise<SettledDrafts<T>> {
	const restoreStatus = new Map(restore.map((state) => [state.id, state.status]));
	const settled: SettledDrafts<T> = { rest: [], deleted: 0, refused: 0 };
	for (const message of selected) {
		if (isHiddenDraft(message, userId)) continue;
		const handling = bulkDraftHandling(action, message.status, restoreStatus.get(message.id));
		if (handling === "normal") settled.rest.push(message);
		else if (handling === "refuse") settled.refused += 1;
		else if (await discardOwnDraft(env, db, userId, message)) settled.deleted += 1;
	}
	return settled;
}

async function discardOwnDraft(env: CloudflareEnv, db: AppDatabase, userId: string, message: SelectedMessage) {
	// Still the caller's draft at write time, so a draft that was sent in the meantime is never deleted.
	const [row] = await db
		.select({ id: messages.id })
		.from(messages)
		.where(and(eq(messages.id, message.id), eq(messages.userId, userId), eq(messages.status, "draft")))
		.limit(1);
	if (!row) return false;
	await deleteMessageWithObjects(env, db, message.id, message.rawR2Key);
	return true;
}

/** The draft counts a response carries, only when a selection held drafts. */
export function draftCounts(drafts: SettledDrafts<unknown>) {
	return drafts.deleted || drafts.refused ? { draftsDeleted: drafts.deleted, draftsRefused: drafts.refused } : {};
}

/** The answer when nothing but drafts (or nothing at all) was left to act on. */
export function draftsOnlyResponse(drafts: SettledDrafts<unknown>) {
	if (drafts.deleted > 0) return NextResponse.json({ ok: true, ...draftCounts(drafts) });
	if (drafts.refused > 0)
		return NextResponse.json(
			{ error: "Drafts can only be sent or deleted", code: "DRAFT_MOVE_REFUSED", draftsRefused: drafts.refused },
			{ status: 409 },
		);
	return NextResponse.json({ error: "No accessible messages" }, { status: 404 });
}
