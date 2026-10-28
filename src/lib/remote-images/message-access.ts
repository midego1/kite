import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { messages } from "@/db/schema";
import type { SessionUser } from "@/lib/auth/types";
import { loadMessageBody } from "@/lib/email/bodies";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { isHiddenDraft } from "@/lib/messages/draft-privacy-utils";
import { messageHtmlReferencesImage } from "./message-urls-utils";

/** True only when `user` can read the message and its stored HTML shows `imageUrl`. */
export async function canProxyMessageImage(
	env: CloudflareEnv,
	user: Pick<SessionUser, "id" | "role">,
	messageId: string,
	imageUrl: string,
	base: string,
): Promise<boolean> {
	const db = getDb(env);
	const [row] = await db
		.select({
			id: messages.id,
			mailboxId: messages.mailboxId,
			htmlBody: messages.htmlBody,
			status: messages.status,
			userId: messages.userId,
		})
		.from(messages)
		.where(eq(messages.id, messageId))
		.limit(1);
	if (!row?.mailboxId || isHiddenDraft(row, user.id)) return false;
	const access = await getMailboxAccessLevel(db, user, row.mailboxId);
	if (!access?.canRead) return false;
	const { htmlBody } = await loadMessageBody(env, row);
	return !!htmlBody && messageHtmlReferencesImage(htmlBody, imageUrl, base);
}
