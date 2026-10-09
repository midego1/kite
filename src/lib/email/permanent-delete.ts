import { inArray } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { messageAttachments, messages } from "@/db/schema";
import { chunkArray, queryInChunks, runInChunks } from "@/db/chunk-utils";
import { createAuditLogs } from "@/lib/mailboxes/audit";

type DeletableMessage = {
	id: string;
	mailboxId: string | null;
	rawR2Key: string | null;
	status: string;
};

/** R2 accepts up to 1,000 keys in one delete call. */
const R2_DELETE_BATCH = 1000;

/**
 * Permanently remove messages (row, raw MIME and attachment objects) and audit
 * each one. Objects go first, so a failure never leaves a row whose files are gone
 * unnoticed; rows and audit entries are written in chunks instead of per message.
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
	const attachments = await queryInChunks(ids, (chunk) =>
		db
			.select({ r2Key: messageAttachments.r2Key })
			.from(messageAttachments)
			.where(inArray(messageAttachments.messageId, chunk)),
	);
	const keys = [
		...attachments.map((attachment) => attachment.r2Key),
		...rows.flatMap((row) => (row.rawR2Key ? [row.rawR2Key] : [])),
	];
	for (const batch of chunkArray(keys, R2_DELETE_BATCH)) await env.BUCKET.delete(batch);
	await runInChunks(ids, (chunk) => db.delete(messages).where(inArray(messages.id, chunk)));
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
