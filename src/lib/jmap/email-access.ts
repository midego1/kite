import type { messages } from "@/db/schema";
import type { AccessibleMailbox } from "./types";

type MessageRow = typeof messages.$inferSelect;

/**
 * Which mailboxes an Email/set or Email/import may touch. Drafts can be written by anyone
 * who may send from the mailbox, but changing or deleting mail needs full access (as in
 * the web app), apart from a delegate's own drafts.
 */
export function emailWriteAccess(mailboxes: AccessibleMailbox[], userId: string) {
	const writable = new Set(mailboxes.filter((row) => row.permission !== "read_only").map((row) => row.id));
	const managed = new Set(mailboxes.filter((row) => row.permission === "full_access").map((row) => row.id));
	const canChange = (row: MessageRow, mailboxId: string) =>
		managed.has(mailboxId) || (row.status === "draft" && row.userId === userId && writable.has(mailboxId));
	return { writable, canChange };
}
