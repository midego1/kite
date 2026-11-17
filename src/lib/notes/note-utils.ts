import type { MailboxPermission } from "@/lib/mailboxes/types";

/** Longest note the API accepts, in characters. */
export const NOTE_MAX_LENGTH = 10_000;

/** Most notes one conversation can hold, so one key cannot grow a thread without bound. */
export const NOTE_MAX_PER_CONVERSATION = 200;

/**
 * Anyone who can read the mailbox reads its notes. Writing needs more than read-only access: "read-only" keeps its
 * meaning of adding nothing other people see, so a read-only member of a shared mailbox reads notes but cannot add
 * or edit one; they can still delete a note they wrote before their access was lowered.
 */
export function canWriteNotes(permission: MailboxPermission): boolean {
	return permission !== "read_only";
}

/** Every note shows who wrote it, so only its author changes the text; a note by a deleted account stays as it is. */
export function canEditNote(authorUserId: string | null, viewerId: string, permission: MailboxPermission): boolean {
	return canWriteNotes(permission) && authorUserId !== null && authorUserId === viewerId;
}

/**
 * The author may delete their note, also after their access was lowered to read-only (taking back your own words
 * changes nothing others wrote), and so may anyone with full access to the mailbox, to tidy a shared mailbox.
 */
export function canDeleteNote(authorUserId: string | null, viewerId: string, permission: MailboxPermission): boolean {
	return permission === "full_access" || (authorUserId !== null && authorUserId === viewerId);
}

export type NoteBodyResult = { ok: true; body: string } | { ok: false; error: string };

/** The text of a note as it is stored: line endings normalised, trimmed, not empty and at most NOTE_MAX_LENGTH. */
export function parseNoteBody(value: unknown): NoteBodyResult {
	if (typeof value !== "string") return { ok: false, error: "Write a note first" };
	// NUL and the other C0 controls but tab and newline never belong in a note.
	const body = value
		.replace(/\r\n?/g, "\n")
		.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
		.trim();
	if (!body) return { ok: false, error: "Write a note first" };
	if (body.length > NOTE_MAX_LENGTH)
		return { ok: false, error: `A note can be at most ${NOTE_MAX_LENGTH.toLocaleString("en-US")} characters` };
	return { ok: true, body };
}

/**
 * Timestamps keep whole seconds, so an edit made in the note's own second would look unedited; the stored
 * `updated_at` is always at least a second after `created_at` once the text changed.
 */
export function editedAt(createdAt: Date, now: Date): Date {
	return new Date(Math.max(now.getTime(), createdAt.getTime() + 1000));
}

/** Whether a note's text changed after it was written. */
export function isEdited(createdAt: Date, updatedAt: Date): boolean {
	return updatedAt.getTime() > createdAt.getTime();
}
