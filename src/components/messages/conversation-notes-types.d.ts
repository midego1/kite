import type { ConversationNote } from "@/lib/notes/notes-types";

/** An email of the open conversation, so a pinned note can name the email it is about. */
export type NoteEmail = { id: string; sender: string; createdAt: string };

/** Everything the reader's Notes button and band share for the open conversation. */
export type ConversationNotesController = {
	messageId: string;
	notes: ConversationNote[];
	/** The first load finished (or failed): until then the button shows no count. */
	loaded: boolean;
	canWrite: boolean;
	/** A new note may be pinned to the open email (it is not a draft). */
	canPin: boolean;
	/** Migration 0115 is not applied: the reader shows no notes and no button. */
	unavailable: boolean;
	/** The notes band is shown. */
	open: boolean;
	/** Opening asks the band to focus its composer. */
	composeRequest: number;
	toggle: () => void;
	/** Opens the band and focuses the composer. */
	compose: () => void;
	close: () => void;
	add: (body: string, aboutMessage: boolean) => Promise<string | null>;
	update: (noteId: string, body: string) => Promise<string | null>;
	remove: (noteId: string) => Promise<string | null>;
};
