import { and, asc, eq, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { AppDatabase } from "@/db";
import { messages, users } from "@/db/schema";
import { conversationNotes } from "@/db/schema/conversation-notes";
import type { SessionUser } from "@/lib/auth/types";
import { newId } from "@/lib/ids";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { DRAFT_STATUS, isHiddenDraft } from "@/lib/messages/draft-privacy-utils";
import { isNoSuchTableError } from "@/lib/modules/state-utils";
import { SCREENING_STATUS } from "@/lib/screener/screener-utils";
import type {
	ConversationNote,
	ConversationNotesAnswer,
	NoteChangeError,
	NoteChangeResult,
	NoteConversation,
} from "./notes-types";
import { canDeleteNote, canEditNote, canWriteNotes, editedAt, isEdited, NOTE_MAX_PER_CONVERSATION } from "./note-utils";

/** Thrown by a write before migration 0115; routes answer 409 `MIGRATION_PENDING`. */
export class NotesUnavailableError extends Error {
	constructor() {
		super("Apply the pending database update first");
	}
}

/** Thrown when a conversation already holds NOTE_MAX_PER_CONVERSATION notes. */
export class NoteLimitError extends Error {
	constructor() {
		super(`A conversation can hold at most ${NOTE_MAX_PER_CONVERSATION} notes`);
	}
}

/** Runs a write, turning a missing table into NotesUnavailableError. */
async function writing<T>(run: () => Promise<T>): Promise<T> {
	try {
		return await run();
	} catch (error) {
		if (isNoSuchTableError(error)) throw new NotesUnavailableError();
		throw error;
	}
}

/**
 * The conversation `messageId` sits in, when the user may read its mailbox. Another user's draft, a mailbox the user
 * cannot read and (with `hideScreening`, for API keys and MCP, which never see held mail) a message the Screener holds
 * are not found, so ids do not leak.
 */
export async function conversationForUser(
	db: AppDatabase,
	user: Pick<SessionUser, "id" | "role">,
	messageId: string,
	options: { hideScreening?: boolean; mailboxIds?: readonly string[] | null } = {},
): Promise<NoteConversation | null> {
	const [message] = await db
		.select({
			id: messages.id,
			mailboxId: messages.mailboxId,
			threadId: messages.threadId,
			status: messages.status,
			userId: messages.userId,
		})
		.from(messages)
		.where(eq(messages.id, messageId))
		.limit(1);
	if (!message?.mailboxId || isHiddenDraft(message, user.id)) return null;
	if (options.hideScreening && message.status === SCREENING_STATUS) return null;
	if (options.mailboxIds && !options.mailboxIds.includes(message.mailboxId)) return null;
	const access = await getMailboxAccessLevel(db, user, message.mailboxId);
	if (!access?.canRead) return null;
	return {
		mailboxId: message.mailboxId,
		threadKey: message.threadId ?? message.id,
		messageId: message.id,
		permission: access.permission,
		// A draft is its writer's alone: a note pinned to it would show the others an email they cannot open.
		pinnable: message.status !== DRAFT_STATUS,
	};
}

/**
 * The notes of a conversation: those under its thread key, plus those still under the id of one of its emails. A
 * fresh message keys its conversation by its own id until the send stamps the provider's Message-ID as the thread
 * (send.ts moves its notes then, `rekeyConversationNotes`); this keeps a note reachable from every email of the
 * thread even if that move never happened. The members are a subquery, so a long thread binds no extra parameters.
 */
function conversationCondition(conversation: NoteConversation) {
	return and(
		eq(conversationNotes.mailboxId, conversation.mailboxId),
		or(
			eq(conversationNotes.threadKey, conversation.threadKey),
			eq(conversationNotes.threadKey, conversation.messageId),
			sql`${conversationNotes.threadKey} in (select ${messages.id} from ${messages} where ${messages.mailboxId} = ${conversation.mailboxId} and ${messages.threadId} = ${conversation.threadKey})`,
		),
	);
}

/** The email a note is pinned to, for its status and writer: a pin to a draft is shown only to that draft's writer. */
const pinned = alias(messages, "pinned_message");

const noteColumns = {
	id: conversationNotes.id,
	body: conversationNotes.body,
	messageId: conversationNotes.messageId,
	pinnedStatus: pinned.status,
	pinnedUserId: pinned.userId,
	authorUserId: conversationNotes.authorUserId,
	authorName: users.name,
	createdAt: conversationNotes.createdAt,
	updatedAt: conversationNotes.updatedAt,
};

type NoteRow = {
	id: string;
	body: string;
	messageId: string | null;
	pinnedStatus: string | null;
	pinnedUserId: string | null;
	authorUserId: string | null;
	authorName: string | null;
	createdAt: Date;
	updatedAt: Date;
};

/** The pinned email's id, unless it is (or became, after a send was taken back) a draft the viewer cannot open. */
function visiblePin(row: NoteRow, viewerId: string): string | null {
	if (!row.messageId) return null;
	const hidden =
		row.pinnedStatus !== null &&
		row.pinnedUserId !== null &&
		isHiddenDraft({ status: row.pinnedStatus, userId: row.pinnedUserId }, viewerId);
	return hidden ? null : row.messageId;
}

function toNote(row: NoteRow, conversation: NoteConversation, viewerId: string): ConversationNote {
	return {
		id: row.id,
		body: row.body,
		messageId: visiblePin(row, viewerId),
		author: row.authorUserId ? { id: row.authorUserId, name: row.authorName ?? "" } : null,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
		edited: isEdited(row.createdAt, row.updatedAt),
		canEdit: canEditNote(row.authorUserId, viewerId, conversation.permission),
		canDelete: canDeleteNote(row.authorUserId, viewerId, conversation.permission),
	};
}

async function selectNotes(db: AppDatabase, conversation: NoteConversation, noteId?: string): Promise<NoteRow[]> {
	return (
		db
			.select(noteColumns)
			.from(conversationNotes)
			.leftJoin(users, eq(conversationNotes.authorUserId, users.id))
			.leftJoin(pinned, eq(conversationNotes.messageId, pinned.id))
			.where(
				noteId
					? and(conversationCondition(conversation), eq(conversationNotes.id, noteId))
					: conversationCondition(conversation),
			)
			// Whole seconds: notes written in the same second keep the order they were inserted in.
			.orderBy(asc(conversationNotes.createdAt), asc(sql`${conversationNotes}.rowid`))
			.limit(NOTE_MAX_PER_CONVERSATION)
	);
}

/** Every note of the conversation, oldest first; before migration 0115 an empty list marked `migrationPending`. */
export async function listConversationNotes(
	db: AppDatabase,
	conversation: NoteConversation,
	viewerId: string,
): Promise<ConversationNotesAnswer> {
	try {
		const rows = await selectNotes(db, conversation);
		return {
			notes: rows.map((row) => toNote(row, conversation, viewerId)),
			canWrite: canWriteNotes(conversation.permission),
			canPin: conversation.pinnable,
		};
	} catch (error) {
		if (isNoSuchTableError(error)) return { notes: [], canWrite: false, canPin: false, migrationPending: true };
		throw error;
	}
}

/**
 * Adds a note by `viewerId`; with `aboutMessage` it is about the email the conversation was looked up from rather
 * than the whole conversation; the caller must have checked `canWriteNotes` and, for a pin, `pinnable`. The count
 * and the insert are one statement, so concurrent writes cannot push a conversation past the limit.
 */
export async function addConversationNote(
	db: AppDatabase,
	conversation: NoteConversation,
	viewerId: string,
	input: { body: string; aboutMessage?: boolean },
): Promise<ConversationNote> {
	return writing(async () => {
		const id = newId("note");
		// Timestamps are whole seconds, as Drizzle's timestamp mode stores them.
		const now = Math.floor(Date.now() / 1000);
		const pin = input.aboutMessage && conversation.pinnable ? conversation.messageId : null;
		const inserted = await db.all<{ id: string }>(sql`
			insert into ${conversationNotes} (id, mailbox_id, thread_key, message_id, body, author_user_id, created_at, updated_at)
			select ${id}, ${conversation.mailboxId}, ${conversation.threadKey}, ${pin}, ${input.body}, ${viewerId}, ${now}, ${now}
			where (select count(*) from ${conversationNotes} where ${conversationCondition(conversation)}) < ${NOTE_MAX_PER_CONVERSATION}
			returning id
		`);
		if (inserted.length === 0) throw new NoteLimitError();
		const [row] = await selectNotes(db, conversation, id);
		if (!row) throw new Error("The note was not saved");
		return toNote(row, conversation, viewerId);
	});
}

/** The note when it belongs to this conversation; a note of another conversation or mailbox is not found. */
async function noteInConversation(db: AppDatabase, conversation: NoteConversation, noteId: string) {
	const [row] = await selectNotes(db, conversation, noteId);
	return row ?? null;
}

/** Replaces the text of a note in this conversation; only its author may. */
export async function updateConversationNote(
	db: AppDatabase,
	conversation: NoteConversation,
	viewerId: string,
	noteId: string,
	body: string,
): Promise<NoteChangeResult> {
	return writing(async () => {
		const row = await noteInConversation(db, conversation, noteId);
		if (!row) return refused("not_found");
		if (!canEditNote(row.authorUserId, viewerId, conversation.permission)) return refused("forbidden");
		const updatedAt = row.body === body ? row.updatedAt : editedAt(row.createdAt, new Date());
		await db.update(conversationNotes).set({ body, updatedAt }).where(eq(conversationNotes.id, noteId));
		return { ok: true, note: toNote({ ...row, body, updatedAt }, conversation, viewerId) };
	});
}

/** Deletes a note in this conversation; its author or someone with full access to the mailbox may. */
export async function deleteConversationNote(
	db: AppDatabase,
	conversation: NoteConversation,
	viewerId: string,
	noteId: string,
): Promise<{ ok: true; authorUserId: string | null } | { ok: false; error: NoteChangeError }> {
	return writing(async () => {
		const row = await noteInConversation(db, conversation, noteId);
		if (!row) return refused("not_found");
		if (!canDeleteNote(row.authorUserId, viewerId, conversation.permission)) return refused("forbidden");
		await db.delete(conversationNotes).where(eq(conversationNotes.id, noteId));
		return { ok: true, authorUserId: row.authorUserId };
	});
}

function refused(error: NoteChangeError): { ok: false; error: NoteChangeError } {
	return { ok: false, error };
}

/**
 * A fresh message's notes were keyed by its own id while it waited to be sent; once the send stamps the provider's
 * Message-ID as its thread, they move onto that key so they stay with the conversation even if the message is
 * deleted. Before migration 0115 there is nothing to move.
 */
export async function rekeyConversationNotes(
	db: AppDatabase,
	mailboxId: string,
	fromKey: string,
	toKey: string,
): Promise<void> {
	if (fromKey === toKey) return;
	try {
		await db
			.update(conversationNotes)
			.set({ threadKey: toKey })
			.where(and(eq(conversationNotes.mailboxId, mailboxId), eq(conversationNotes.threadKey, fromKey)));
	} catch (error) {
		if (!isNoSuchTableError(error)) throw error;
	}
}
