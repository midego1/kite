import { eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { messageAttachments, messages } from "@/db/schema";
import type { SessionUser } from "@/lib/auth/types";
import { getContactNameFromAddress } from "@/lib/contacts/utils";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import type {
	HostAttachmentContent,
	HostMessageDetail,
	HostMessageOptions,
	HostMessageView,
} from "@/lib/modules/host-types";
import { pickMessageHeaders, utf8Excerpt } from "@/lib/modules/host-utils";
import type { CapabilityCallContext } from "@/lib/modules/module-types";
import { getAttachmentForUser } from "./attachments";
import { loadMessageBody } from "./bodies";
import { encodeRawMime } from "./module-import-utils";
import { readRawHeaders } from "./raw-headers";
import { htmlToReadableText } from "./reply-content-utils";

const TEXT_TYPE = /^text\/|calendar|json|xml/i;

type MessageRow = typeof messages.$inferSelect;
type AttachmentRow = typeof messageAttachments.$inferSelect;

export function actingUser(ctx: CapabilityCallContext): Pick<SessionUser, "id" | "role"> {
	if (!ctx.viewer) throw new Error("Reading mail needs an acting user");
	return { id: ctx.viewer.userId, role: ctx.viewer.role as SessionUser["role"] };
}

/** The attachments of each message, by message id, in one query. */
export async function attachmentsByMessage(
	env: CloudflareEnv,
	messageIds: string[],
): Promise<Map<string, AttachmentRow[]>> {
	const byMessage = new Map<string, AttachmentRow[]>();
	if (messageIds.length === 0) return byMessage;
	const rows = await getDb(env)
		.select()
		.from(messageAttachments)
		.where(inArray(messageAttachments.messageId, messageIds));
	for (const row of rows) byMessage.set(row.messageId, [...(byMessage.get(row.messageId) ?? []), row]);
	return byMessage;
}

export function toHostMessageView(
	message: MessageRow & { mailboxId: string },
	attachments: AttachmentRow[],
): HostMessageView {
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

/** The readable body: the text part, or text from the HTML part. */
export function readableBody(message: Pick<MessageRow, "textBody" | "htmlBody">): string {
	return message.textBody || htmlToReadableText(message.htmlBody);
}

/**
 * A minimal view of a message the viewer can read, or null when it does not exist or is not theirs to
 * read. `text` adds a body excerpt and `headers` the named list headers, read from the stored raw message.
 */
export async function getModuleMessage(
	env: CloudflareEnv,
	ctx: CapabilityCallContext,
	messageId: string,
	options: HostMessageOptions = {},
): Promise<HostMessageDetail | null> {
	const user = actingUser(ctx);
	const db = getDb(env);
	const [message] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
	if (!message?.mailboxId) return null;
	const access = await getMailboxAccessLevel(db, user, message.mailboxId);
	if (!access?.canRead) return null;
	const attachments = await attachmentsByMessage(env, [message.id]);
	const view: HostMessageDetail = {
		...toHostMessageView({ ...message, mailboxId: message.mailboxId }, attachments.get(message.id) ?? []),
		fromName: getContactNameFromAddress(message.fromAddr),
	};
	if (options.text)
		view.textExcerpt = utf8Excerpt(
			readableBody(await loadMessageBody(env, message, { textFirst: true })),
			options.text.maxBytes,
		);
	if (options.headers?.length)
		view.headers = pickMessageHeaders(await readRawHeaders(env, message.rawR2Key), options.headers);
	return view;
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
