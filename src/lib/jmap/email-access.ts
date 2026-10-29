import type { messages } from "@/db/schema";
import { isDraftMoveRefused } from "@/lib/messages/draft-privacy-utils";
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

/**
 * A requested move, unless it would take a draft out of Drafts (destroy or submit it instead) or put anything
 * else into Drafts: a draft is private to its author and everything else is shared with the mailbox.
 */
export function refuseDraftMove<T extends { status?: string } | { error: Record<string, unknown> } | null>(
	currentStatus: string,
	move: T,
): T | { error: Record<string, unknown> } {
	if (!move || "error" in move || move.status === undefined || !isDraftMoveRefused(currentStatus, move.status))
		return move;
	return {
		error: {
			type: "invalidProperties",
			properties: ["mailboxIds"],
			description: "Drafts can only be sent or destroyed, and only drafts belong in Drafts",
		},
	};
}
