import { eq } from "drizzle-orm";
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
