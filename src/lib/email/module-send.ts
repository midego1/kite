import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { domains, mailboxes, messages } from "@/db/schema";
import type { HostDraft } from "@/lib/modules/host-types";
import type { CapabilityCallContext } from "@/lib/modules/module-types";
import { sendEmail } from "./send";

const textEncoder = new TextEncoder();

async function repliedToProviderId(env: CloudflareEnv, mailboxId: string, messageId: string): Promise<string | null> {
	const [row] = await getDb(env)
		.select({ providerMessageId: messages.providerMessageId })
		.from(messages)
		.where(and(eq(messages.id, messageId), eq(messages.mailboxId, mailboxId)))
		.limit(1);
	return row?.providerMessageId ?? null;
}

async function mailboxAddress(env: CloudflareEnv, mailboxId: string): Promise<string> {
	const [row] = await getDb(env)
		.select({ localPart: mailboxes.localPart, hostname: domains.hostname })
		.from(mailboxes)
		.innerJoin(domains, eq(domains.id, mailboxes.domainId))
		.where(eq(mailboxes.id, mailboxId))
		.limit(1);
	if (!row) throw new Error("Mailbox not found");
	return `${row.localPart}@${row.hostname}`.toLowerCase();
}

/**
 * The module send path: `sendEmail` for the acting user, so the sender check, the send limits, the
 * Sent copy, threading, the outbound job and the `message.outbound` webhook apply exactly as for a
 * composer send. A module never chooses whose limits are used; the viewer in the context is the sender.
 */
export async function sendModuleMail(
	env: CloudflareEnv,
	ctx: CapabilityCallContext,
	draft: HostDraft,
): Promise<{ messageId: string }> {
	if (!ctx.viewer) throw new Error("Module mail needs an acting user");
	const replyTo = draft.inReplyToMessageId
		? await repliedToProviderId(env, draft.mailboxId, draft.inReplyToMessageId)
		: null;
	const calendar = draft.calendar;
	const result = await sendEmail(env, {
		userId: ctx.viewer.userId,
		mailboxId: draft.mailboxId,
		from: draft.from?.trim() || (await mailboxAddress(env, draft.mailboxId)),
		to: draft.to,
		cc: draft.cc,
		subject: draft.subject,
		text: draft.text,
		html: draft.html,
		inReplyTo: replyTo,
		references: replyTo,
		messageId: draft.messageId,
		scheduledAt: draft.scheduledAt,
		attachments: calendar
			? [
					{
						filename: "invite.ics",
						type: `text/calendar; ${calendar.method ? `method=${calendar.method}; ` : ""}charset=utf-8`,
						content: textEncoder.encode(calendar.content).buffer as ArrayBuffer,
					},
				]
			: undefined,
	});
	return { messageId: result.messageId };
}
