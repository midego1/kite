import { and, eq } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { messages } from "@/db/schema";
import { deleteMessageAttachmentObjects } from "@/lib/email/attachments";
import { htmlBodyObjectKey } from "@/lib/email/bodies-utils";

/** Remove every external object owned by a message before deleting its row. */
export async function deleteMessageWithObjects(
	env: CloudflareEnv,
	db: AppDatabase,
	id: string,
	rawR2Key: string | null,
): Promise<void> {
	await deleteMessageAttachmentObjects(env, id);
	if (rawR2Key) await env.BUCKET.delete(rawR2Key);
	// The offloaded HTML body, when there is one; deleting a missing object is a no-op.
	await env.BUCKET.delete(htmlBodyObjectKey(id));
	await db.delete(messages).where(eq(messages.id, id));
}

/**
 * Deletes one user's drafts in a mailbox, with their objects, when they lose access to it. Drafts are private
 * to their author, so nobody else could ever open or send them; left behind they would only take up space.
 */
export async function deleteUserDraftsInMailbox(
	env: CloudflareEnv,
	db: AppDatabase,
	mailboxId: string,
	userId: string,
): Promise<number> {
	const drafts = await db
		.select({ id: messages.id, rawR2Key: messages.rawR2Key })
		.from(messages)
		.where(and(eq(messages.mailboxId, mailboxId), eq(messages.userId, userId), eq(messages.status, "draft")));
	for (const draft of drafts) await deleteMessageWithObjects(env, db, draft.id, draft.rawR2Key);
	return drafts.length;
}
