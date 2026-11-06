import { eq } from "drizzle-orm";
import { messages } from "@/db/schema";
import { deleteMessageWithObjects } from "@/lib/email/message-cleanup";
import { recordDeletes, recordKiteChange, recordMove } from "@/lib/external-accounts/two-way-record";
import type { JmapContext } from "./types";

type MessageRow = typeof messages.$inferSelect;

/**
 * JMAP destroy is permanent; Kite keeps a trash, so destroy moves there and a second destroy from Trash deletes the
 * row. Either way it is a delete by the person behind the key, so two-way sync hears of it first: the row may not
 * exist afterwards.
 */
export async function destroyEmails(
	ctx: JmapContext,
	rows: readonly MessageRow[],
	ids: readonly string[],
	canChange: (row: MessageRow, mailboxId: string) => boolean,
) {
	const destroyed: string[] = [];
	const notDestroyed: Record<string, unknown> = {};
	const byId = new Map(rows.map((row) => [row.id, row]));
	for (const id of ids) {
		const row = byId.get(id);
		if (!row || !row.mailboxId) {
			notDestroyed[id] = { type: "notFound" };
			continue;
		}
		if (!canChange(row, row.mailboxId)) {
			notDestroyed[id] = { type: "forbidden" };
			continue;
		}
		await recordDeletes(ctx.env, ctx.auth.user, [row]);
		if (row.status === "trash" || row.status === "draft")
			await deleteMessageWithObjects(ctx.env, ctx.db, row.id, row.rawR2Key);
		else await ctx.db.update(messages).set({ status: "trash", folderId: null }).where(eq(messages.id, id));
		destroyed.push(id);
	}
	return { destroyed, notDestroyed };
}

/** A client's `Email/set` update, for two-way sync: the flags it set, and the move if the status really changed. */
export async function recordEmailUpdate(
	env: CloudflareEnv,
	actor: JmapContext["auth"]["user"],
	message: { id: string; status: string },
	set: Partial<Pick<MessageRow, "read" | "starred" | "status">>,
): Promise<void> {
	if (set.read !== undefined || set.starred !== undefined)
		await recordKiteChange(env, actor, [message.id], { kind: "flags", read: set.read, starred: set.starred });
	if (set.status !== undefined && set.status !== message.status) await recordMove(env, actor, message, set.status);
}
