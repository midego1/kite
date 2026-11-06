import { inArray } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { messages } from "@/db/schema";
import { runInChunks } from "@/db/chunk-utils";
import { htmlBodyObjectKey } from "@/lib/email/bodies-utils";
import { messageAttachmentKeys } from "@/lib/email/attachments";
import { deleteUnreferencedObjects } from "@/lib/email/attachment-storage";
import { recordKiteChange } from "@/lib/external-accounts/two-way-record";
import { createAuditLogs } from "@/lib/mailboxes/audit";

type DeletableMessage = {
	id: string;
	mailboxId: string | null;
	rawR2Key: string | null;
	status: string;
};

/**
 * Permanently remove messages (row, raw MIME, offloaded HTML body and attachment objects) and audit
 * each one. Rows go first, then the objects no remaining row names (`docs/specs/attachments-once.md` §5.4):
 * an attachment object can be shared with another message (a forward, a send from a draft), and if
 * storage fails afterwards the cost is an orphaned object, never a missing file that another message
 * still uses. Rows and audit entries are written in chunks instead of per message.
 * The audit row cannot point at the deleted message, since its `message_id` is a
 * foreign key, so the id travels in the metadata instead.
 */
export async function permanentlyDeleteMessages(
	env: CloudflareEnv,
	db: AppDatabase,
	actorUserId: string,
	rows: DeletableMessage[],
	source: "bulk" | "empty" | "retention",
): Promise<number> {
	if (rows.length === 0) return 0;
	const ids = rows.map((row) => row.id);
	// A person deleting it forever is "Delete in Kite"; the row must still exist to be looked up. Retention is not.
	if (source !== "retention") await recordKiteChange(env, ids, { kind: "trash" });
	const attachmentKeys = await messageAttachmentKeys(env, ids);
	// Attachment rows cascade from the message.
	await runInChunks(ids, (chunk) => db.delete(messages).where(inArray(messages.id, chunk)));
	await deleteUnreferencedObjects(env, {
		attachmentKeys,
		rawKeys: rows.map((row) => row.rawR2Key),
		// Offloaded HTML bodies have one key per message, so no column read is needed to find them.
		ownedKeys: ids.map(htmlBodyObjectKey),
	});
	await createAuditLogs(
		env,
		rows.map((row) => ({
			actorUserId,
			mailboxId: row.mailboxId,
			action: "email.delete",
			metadata: { permanent: true, source, messageId: row.id, previousStatus: row.status },
		})),
	);
	return rows.length;
}
