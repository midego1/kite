import { NextResponse } from "next/server";
import { getDb } from "@/db";
import type { SessionUser } from "@/lib/auth/types";
import { RequestBodyTooLargeError } from "@/lib/http/errors";
import { readJsonBody } from "@/lib/http/request";
import { allowAgentRequest } from "@/lib/agent/rate-limit";
import { createLogger } from "@/lib/logger.mjs";
import { createAuditLog } from "@/lib/mailboxes/audit";
import type { NoteChangeError, NoteConversation } from "./notes-types";
import { canWriteNotes, NOTE_MAX_LENGTH, parseNoteBody } from "./note-utils";
import {
	addConversationNote,
	conversationForUser,
	deleteConversationNote,
	listConversationNotes,
	NoteLimitError,
	NotesUnavailableError,
	updateConversationNote,
} from "./service";

/** Who is asking: a signed-in user, or an API key's user limited to the key's mailboxes. */
export type NotesViewer = {
	user: Pick<SessionUser, "id" | "role">;
	/** The mailboxes an API key names; null for a session or a key for every mailbox. */
	mailboxIds: readonly string[] | null;
	/** API keys never see mail the Screener holds, as everywhere else in `/api/v1`. */
	hideScreening: boolean;
	/** Recorded on the audit row of a write. */
	via: "session" | "api_key";
};

const log = createLogger("notes");

const NO_STORE = { "Cache-Control": "no-store" };
/** The JSON a note write may carry: the text (with room for escaping) and a flag. */
const MAX_BODY_BYTES = NOTE_MAX_LENGTH * 6 + 1_000;

const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });
const notFound = () => json({ error: "Message not found" }, 404);
const readOnly = () => json({ error: "You have read-only access to this mailbox", code: "READ_ONLY" }, 403);

function changeRefused(error: NoteChangeError) {
	return error === "forbidden"
		? json({ error: "You cannot change this note", code: "FORBIDDEN" }, 403)
		: json({ error: "Note not found" }, 404);
}

function writeFailed(error: unknown) {
	if (error instanceof NotesUnavailableError) return json({ error: error.message, code: "MIGRATION_PENDING" }, 409);
	if (error instanceof NoteLimitError) return json({ error: error.message, code: "NOTE_LIMIT" }, 409);
	throw error;
}

async function readBody(request: Request): Promise<{ body: Record<string, unknown> } | { error: NextResponse }> {
	try {
		const body = await readJsonBody<unknown>(request, MAX_BODY_BYTES);
		if (body && typeof body === "object" && !Array.isArray(body)) return { body: body as Record<string, unknown> };
	} catch (error) {
		if (error instanceof RequestBodyTooLargeError) return { error: json({ error: "Note is too long" }, 413) };
	}
	return { error: json({ error: "Invalid request" }, 400) };
}

async function load(env: CloudflareEnv, viewer: NotesViewer, messageId: string) {
	const db = getDb(env);
	const conversation = await conversationForUser(db, viewer.user, messageId, {
		hideScreening: viewer.hideScreening,
		mailboxIds: viewer.mailboxIds,
	});
	return { db, conversation };
}

/** `GET …/notes`: the notes of the conversation, oldest first, with what the viewer may do. */
export async function respondListNotes(env: CloudflareEnv, viewer: NotesViewer, messageId: string) {
	const { db, conversation } = await load(env, viewer, messageId);
	if (!conversation) return notFound();
	return json(await listConversationNotes(db, conversation, viewer.user.id));
}

type NoteAuditAction = "note.added" | "note.edited" | "note.deleted";

/**
 * One audit row per note write (who, which note, through what), never the text. Deleting someone else's note names
 * them as the target. A failing write is logged and never fails the request.
 */
async function auditNote(
	env: CloudflareEnv,
	viewer: NotesViewer,
	conversation: NoteConversation,
	action: NoteAuditAction,
	note: { id: string; authorUserId: string | null },
) {
	const ofOther = note.authorUserId !== viewer.user.id;
	try {
		await createAuditLog(env, {
			actorUserId: viewer.user.id,
			targetUserId: ofOther ? note.authorUserId : null,
			mailboxId: conversation.mailboxId,
			messageId: conversation.messageId,
			action,
			metadata: { noteId: note.id, via: viewer.via, ...(ofOther ? { ofOtherAuthor: true } : {}) },
		});
	} catch (error) {
		log.warn("notes.audit_failed", { action, error });
	}
}

/** Loads the conversation for a write, refusing a missing message, (for `requireWrite`) read-only access and a burst. */
async function loadForWrite(env: CloudflareEnv, viewer: NotesViewer, messageId: string, requireWrite: boolean) {
	const { db, conversation } = await load(env, viewer, messageId);
	if (!conversation) return { error: notFound() };
	if (requireWrite && !canWriteNotes(conversation.permission)) return { error: readOnly() };
	if (!(await allowAgentRequest(env, `notes:${viewer.user.id}`)))
		return { error: json({ error: "Too many note changes; try again in a minute", code: "RATE_LIMITED" }, 429) };
	return { db, conversation };
}

/** `POST …/notes` with `{ body, aboutMessage? }`: adds a note; `aboutMessage: true` pins it to this email. */
export async function respondAddNote(env: CloudflareEnv, viewer: NotesViewer, messageId: string, request: Request) {
	const loaded = await loadForWrite(env, viewer, messageId, true);
	if ("error" in loaded) return loaded.error;
	const { db, conversation } = loaded;
	const input = await readBody(request);
	if ("error" in input) return input.error;
	const parsed = parseNoteBody(input.body.body);
	if (!parsed.ok) return json({ error: parsed.error }, 400);
	const aboutMessage = input.body.aboutMessage === true;
	if (aboutMessage && !conversation.pinnable) return json({ error: "A note cannot be pinned to a draft" }, 400);
	try {
		const note = await addConversationNote(db, conversation, viewer.user.id, { body: parsed.body, aboutMessage });
		await auditNote(env, viewer, conversation, "note.added", { id: note.id, authorUserId: viewer.user.id });
		return json({ note }, 201);
	} catch (error) {
		return writeFailed(error);
	}
}

/** `PATCH …/notes/[noteId]` with `{ body }`: replaces the text of the viewer's own note. */
export async function respondUpdateNote(
	env: CloudflareEnv,
	viewer: NotesViewer,
	messageId: string,
	noteId: string,
	request: Request,
) {
	const loaded = await loadForWrite(env, viewer, messageId, true);
	if ("error" in loaded) return loaded.error;
	const { db, conversation } = loaded;
	const input = await readBody(request);
	if ("error" in input) return input.error;
	const parsed = parseNoteBody(input.body.body);
	if (!parsed.ok) return json({ error: parsed.error }, 400);
	try {
		const result = await updateConversationNote(db, conversation, viewer.user.id, noteId, parsed.body);
		if (!result.ok) return changeRefused(result.error);
		await auditNote(env, viewer, conversation, "note.edited", { id: noteId, authorUserId: viewer.user.id });
		return json({ note: result.note });
	} catch (error) {
		return writeFailed(error);
	}
}

/**
 * `DELETE …/notes/[noteId]`: the author (also after their access was lowered to read-only), or someone with full
 * access to the mailbox, deletes a note.
 */
export async function respondDeleteNote(env: CloudflareEnv, viewer: NotesViewer, messageId: string, noteId: string) {
	const loaded = await loadForWrite(env, viewer, messageId, false);
	if ("error" in loaded) return loaded.error;
	const { db, conversation } = loaded;
	try {
		const result = await deleteConversationNote(db, conversation, viewer.user.id, noteId);
		if (!result.ok) return changeRefused(result.error);
		await auditNote(env, viewer, conversation, "note.deleted", { id: noteId, authorUserId: result.authorUserId });
		return json({ ok: true });
	} catch (error) {
		return writeFailed(error);
	}
}
