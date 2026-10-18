import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { messages } from "@/db/schema";
import type { SessionUser } from "@/lib/auth/types";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
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
	const [message] = await db
		.select({ mailboxId: messages.mailboxId, htmlBody: messages.htmlBody })
		.from(messages)
		.where(eq(messages.id, messageId))
		.limit(1);
	if (!message?.mailboxId || !message.htmlBody) return false;
	const access = await getMailboxAccessLevel(db, user, message.mailboxId);
	if (!access?.canRead) return false;
	return messageHtmlReferencesImage(message.htmlBody, imageUrl, base);
}
