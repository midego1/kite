import { and, count, eq, type SQL } from "drizzle-orm";
import { getDb } from "@/db";
import { folders, messages, routingRules } from "@/db/schema";
import { movedStatus, storedMessagePlaces } from "../chat-actions-utils";
import { AgentActionError } from "./action-error";
import type { AgentActionRow } from "./actions-types";
import { parseActionState } from "./actions-utils";
import { restoreMarkedSpam } from "./suggestion-effects";

const MOVED_AGAIN = "The emails were moved again since, so Kite left them where they are";

/** Puts each message back unless it left the state the action put it in; returns how many moved back. */
async function restorePlaces(env: CloudflareEnv, row: AgentActionRow, stillThere: SQL): Promise<number> {
	const places = storedMessagePlaces(parseActionState(row.before)) ?? [];
	const db = getDb(env);
	let restored = 0;
	for (const place of places) {
		const updated = await db
			.update(messages)
			.set({ status: place.status, folderId: place.folderId })
			.where(and(eq(messages.id, place.id), eq(messages.mailboxId, row.mailboxId), stillThere))
			.returning({ id: messages.id });
		restored += updated.length;
	}
	return restored;
}

/**
 * Undo of a move. A move approved in chat saved every message's place in `before` and puts back the ones
 * still in the destination; "Mark as spam" from a phishing warning saved one place and reopens the warning.
 */
export async function undoMove(env: CloudflareEnv, row: AgentActionRow): Promise<void> {
	if (!storedMessagePlaces(parseActionState(row.before))) return restoreMarkedSpam(env, row);
	const status = movedStatus(row.variant);
	const restored = await restorePlaces(env, row, eq(messages.status, status));
	if (restored === 0) throw new AgentActionError(MOVED_AGAIN, 409);
}

/** Undo of filing mail into a folder: the messages still in that folder go back where they were. */
export async function undoSetFolder(env: CloudflareEnv, row: AgentActionRow): Promise<void> {
	const folderId = parseActionState(row.after)?.folderId;
	if (typeof folderId !== "string") throw new AgentActionError("This action cannot be undone", 409);
	const restored = await restorePlaces(env, row, eq(messages.folderId, folderId));
	if (restored === 0) throw new AgentActionError(MOVED_AGAIN, 409);
}

/** Undo of a read-state change: messages still in the state the action set get their earlier state back. */
export async function undoMarkRead(env: CloudflareEnv, row: AgentActionRow): Promise<void> {
	const places = storedMessagePlaces(parseActionState(row.before)) ?? [];
	const applied = row.variant === "read";
	const db = getDb(env);
	for (const place of places) {
		if (place.read === applied) continue;
		await db
			.update(messages)
			.set({ read: place.read })
			.where(and(eq(messages.id, place.id), eq(messages.mailboxId, row.mailboxId), eq(messages.read, applied)));
	}
}

/** Undo of creating a folder: deletes it, unless mail was filed in it or a mailbox rule uses it since. */
export async function undoCreateFolder(env: CloudflareEnv, row: AgentActionRow): Promise<void> {
	const folderId = parseActionState(row.after)?.folderId;
	if (typeof folderId !== "string") throw new AgentActionError("This action cannot be undone", 409);
	const db = getDb(env);
	const [filed] = await db.select({ value: count() }).from(messages).where(eq(messages.folderId, folderId));
	const [rules] = await db.select({ value: count() }).from(routingRules).where(eq(routingRules.folderId, folderId));
	if ((filed?.value ?? 0) > 0 || (rules?.value ?? 0) > 0)
		throw new AgentActionError("The folder is in use now, so Kite kept it", 409);
	await db.delete(folders).where(and(eq(folders.id, folderId), eq(folders.mailboxId, row.mailboxId)));
}
