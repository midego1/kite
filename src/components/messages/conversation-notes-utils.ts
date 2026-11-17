import type { ConversationNote } from "@/lib/notes/notes-types";
import type { NoteEmail } from "./conversation-notes-types";

/** The id of the notes band, which the toolbar button controls. */
export const NOTES_BAND_ID = "conversation-notes";

export const notesUrl = (messageId: string) => `/api/messages/${encodeURIComponent(messageId)}/notes`;

export const noteUrl = (messageId: string, noteId: string) => `${notesUrl(messageId)}/${encodeURIComponent(noteId)}`;

/** Initials for a note author's avatar: the first letters of the first two words, or "?" for a deleted account. */
export function authorInitials(name: string | null | undefined): string {
	const words = (name ?? "").trim().split(/\s+/).filter(Boolean);
	if (words.length === 0) return "?";
	return words
		.slice(0, 2)
		.map((word) => Array.from(word)[0]!.toUpperCase())
		.join("");
}

/** The email a pinned note is about, when it is still shown in the conversation; null for an unpinned note. */
export function pinnedEmail(note: Pick<ConversationNote, "messageId">, emails: readonly NoteEmail[]) {
	if (!note.messageId) return null;
	return emails.find((email) => email.id === note.messageId) ?? { id: note.messageId, sender: null, createdAt: null };
}
