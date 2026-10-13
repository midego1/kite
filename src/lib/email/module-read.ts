import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { messageAttachments, messages } from "@/db/schema";
import type { SessionUser } from "@/lib/auth/types";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import type { HostAttachmentContent, HostMessageView } from "@/lib/modules/host-types";
import type { CapabilityCallContext } from "@/lib/modules/module-types";
import { getAttachmentForUser } from "./attachments";
import { encodeRawMime } from "./module-import-utils";

const TEXT_TYPE = /^text\/|calendar|json|xml/i;

function actingUser(ctx: CapabilityCallContext): Pick<SessionUser, "id" | "role"> {
	if (!ctx.viewer) throw new Error("Reading mail needs an acting user");
	return { id: ctx.viewer.userId, role: ctx.viewer.role as SessionUser["role"] };
}

/** A minimal view of a message the viewer can read, or null when it does not exist or is not theirs to read. */
export async function getModuleMessage(
	env: CloudflareEnv,
	ctx: CapabilityCallContext,
	messageId: string,
): Promise<HostMessageView | null> {
	const user = actingUser(ctx);
	const db = getDb(env);
	const [message] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
	if (!message?.mailboxId) return null;
	const access = await getMailboxAccessLevel(db, user, message.mailboxId);
	if (!access?.canRead) return null;
	const attachments = await db.select().from(messageAttachments).where(eq(messageAttachments.messageId, message.id));
	return {
		id: message.id,
		mailboxId: message.mailboxId,
		from: message.fromAddr,
		subject: message.subject,
		receivedAt: message.createdAt.toISOString(),
		attachments: attachments.map((item) => ({
			id: item.id,
			contentType: item.contentType,
			filename: item.filename,
			size: item.size,
		})),
	};
}

/** One attachment's content for a viewer who can read the message: text for text types, base64 otherwise, cut at `maxBytes`. */
export async function readModuleAttachment(
	env: CloudflareEnv,
	ctx: CapabilityCallContext,
	messageId: string,
	attachmentId: string,
	options: { maxBytes: number },
): Promise<HostAttachmentContent | null> {
	const user = actingUser(ctx);
	const found = await getAttachmentForUser(env, user as SessionUser, messageId, attachmentId);
	if (!found) return null;
	const { attachment, object } = found;
	const truncated = attachment.size > options.maxBytes;
	const source = truncated
		? ((await env.BUCKET.get(attachment.r2Key, { range: { offset: 0, length: options.maxBytes } })) ?? object)
		: object;
	const bytes = new Uint8Array(await source.arrayBuffer()).subarray(0, options.maxBytes);
	if (TEXT_TYPE.test(attachment.contentType))
		return { encoding: "text", content: new TextDecoder().decode(bytes), truncated };
	return { encoding: "base64", content: encodeRawMime(bytes), truncated };
}
