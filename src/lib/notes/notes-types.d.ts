import type { MailboxPermission } from "@/lib/mailboxes/types";

/** One note as the API returns it to a particular viewer. */
export type ConversationNote = {
	id: string;
	/** Plain text; never rendered as HTML. */
	body: string;
	/** The email of the conversation this note is about; null when it is about the whole conversation. */
	messageId: string | null;
	/** The author; null once that account is deleted. */
	author: { id: string; name: string } | null;
	createdAt: string;
	updatedAt: string;
	/** The text was changed after the note was written. */
	edited: boolean;
	/** The viewer may change the text: only its author, while they may still write notes in the mailbox. */
	canEdit: boolean;
	/** The viewer may delete it: its author (while they may write), or anyone with full access to the mailbox. */
	canDelete: boolean;
};

/** The notes of one conversation, for a viewer. */
export type ConversationNotesAnswer = {
	notes: ConversationNote[];
	/** The viewer may add notes; false for read-only access and before the database update. */
	canWrite: boolean;
	/** Migration 0115 has not been applied yet: there are no notes and none can be written. */
	migrationPending?: true;
};

/** The conversation of one email, as seen by a user who may read its mailbox. */
export type NoteConversation = {
	mailboxId: string;
	/** The key new notes are stored under: the thread id, or the email's own id when it was never threaded. */
	threadKey: string;
	/** The email the conversation was looked up from; a note pinned "to this email" names it. */
	messageId: string;
	permission: MailboxPermission;
};

export type NoteChangeError = "not_found" | "forbidden";

export type NoteChangeResult = { ok: true; note: ConversationNote } | { ok: false; error: NoteChangeError };
