import { and, eq, isNull, notExists } from "drizzle-orm";
import { getDb } from "@/db";
import { folders, messages, routingRules } from "@/db/schema";
import type { UndoCounts } from "../chat-actions-types";
import { storedChatActionState, undoTargets } from "../chat-actions-utils";
import { AgentActionError } from "./action-error";
import type { AgentActionRow } from "./actions-types";
import { parseActionState } from "./actions-utils";
import { undoLatestSpamReceipt } from "@/lib/spam/report-receipts";
import { restoreMarkedSpam } from "./suggestion-effects";

const MOVED_AGAIN = "The emails were moved again since, so Kite left them where they are";
const CHANGED_AGAIN = "The emails were marked again since, so Kite left them as they are";

function chatState(row: AgentActionRow) {
	const state = storedChatActionState(parseActionState(row.before));
	if (!state) throw new AgentActionError("This action cannot be undone", 409);
	return state;
}

/**
 * Puts back each message the action changed while it is still exactly where the action left it: the same
 * status and folder (and read state, for a read change). A message moved, filed or marked again since is
 * left alone, so an undo never overwrites a later change. Nothing put back at all is a 409.
 */
async function restoreChanged(
	env: CloudflareEnv,
	row: AgentActionRow,
	field: "place" | "read",
	refusal: string,
): Promise<UndoCounts> {
	const targets = undoTargets(chatState(row), field);
	const db = getDb(env);
	let restored = 0;
	for (const { before, applied } of targets) {
		const updated = await db
			.update(messages)
			.set(field === "read" ? { read: before.read } : { status: before.status, folderId: before.folderId })
			.where(
				and(
					eq(messages.id, before.id),
					eq(messages.mailboxId, row.mailboxId),
					eq(messages.status, applied.status),
					applied.folderId === null ? isNull(messages.folderId) : eq(messages.folderId, applied.folderId),
					...(field === "read" ? [eq(messages.read, applied.read)] : []),
				),
			)
			.returning({ id: messages.id });
		restored += updated.length;
		// A move to or out of Spam also trained the filter, so putting the message back takes that back too.
		if (field === "place" && updated.length > 0) {
			if (applied.status === "spam") await undoLatestSpamReceipt(env, before.id, "to_spam", row.createdAt);
			else if (before.status === "spam" && applied.status === "received")
				await undoLatestSpamReceipt(env, before.id, "from_spam", row.createdAt);
		}
	}
	if (targets.length > 0 && restored === 0) throw new AgentActionError(refusal, 409);
	return { restored, total: targets.length };
}

/**
 * Undo of a move. A row written by an approved chat action carries the chat marker and puts its messages
 * back; any other move row is a "Mark as spam" from a phishing warning, which also reopens the warning.
 */
export async function undoMove(env: CloudflareEnv, row: AgentActionRow): Promise<UndoCounts | void> {
	if (!storedChatActionState(parseActionState(row.before))) return restoreMarkedSpam(env, row);
	return restoreChanged(env, row, "place", MOVED_AGAIN);
}

/** Undo of filing mail into a folder: the messages still filed there go back where they were. */
export async function undoSetFolder(env: CloudflareEnv, row: AgentActionRow): Promise<UndoCounts> {
	return restoreChanged(env, row, "place", MOVED_AGAIN);
}

/** Undo of a read-state change: messages still in the state the action set get their earlier state back. */
export async function undoMarkRead(env: CloudflareEnv, row: AgentActionRow): Promise<UndoCounts> {
	return restoreChanged(env, row, "read", CHANGED_AGAIN);
}

/** Undo of creating a folder: deletes it, unless mail was filed in it or a mailbox rule uses it since. */
export async function undoCreateFolder(env: CloudflareEnv, row: AgentActionRow): Promise<void> {
	const folderId = parseActionState(row.after)?.folderId;
	if (typeof folderId !== "string") throw new AgentActionError("This action cannot be undone", 409);
	const db = getDb(env);
	// The in-use checks ride the delete, so mail or a rule added after a separate read still wins; both
	// references are ON DELETE SET NULL, so an unchecked delete would silently drop the new assignment.
	const deleted = await db
		.delete(folders)
		.where(
			and(
				eq(folders.id, folderId),
				eq(folders.mailboxId, row.mailboxId),
				notExists(db.select({ id: messages.id }).from(messages).where(eq(messages.folderId, folders.id))),
				notExists(db.select({ id: routingRules.id }).from(routingRules).where(eq(routingRules.folderId, folders.id))),
			),
		)
		.returning({ id: folders.id });
	if (deleted.length === 0) throw new AgentActionError("The folder is in use now, so Kite kept it", 409);
}
