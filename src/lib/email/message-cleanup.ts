import { and, eq } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { messages } from "@/db/schema";
import { messageAttachmentKeys } from "@/lib/email/attachments";
import { deleteUnreferencedObjects } from "@/lib/email/attachment-storage";
import { htmlBodyObjectKey } from "@/lib/email/bodies-utils";

/**
 * Deletes a message (drafts, templates, JMAP, import rollback, the assistant) and then the objects only it used. The
 * row goes first and its attachment rows cascade with it; an attachment object shared with another message (a send
 * from this draft, the message it forwards) stays (`docs/specs/attachments-once.md` §5.4).
 */
export async function deleteMessageWithObjects(
	env: CloudflareEnv,
	db: AppDatabase,
	id: string,
	rawR2Key: string | null,
): Promise<void> {
	const attachmentKeys = await messageAttachmentKeys(env, [id]);
	await db.delete(messages).where(eq(messages.id, id));
	await deleteUnreferencedObjects(env, {
		attachmentKeys,
		rawKeys: [rawR2Key],
		// The offloaded HTML body, when there is one; deleting a missing object is a no-op.
		ownedKeys: [htmlBodyObjectKey(id)],
	});
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
