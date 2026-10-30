import { NextResponse } from "next/server";
import { markAiAssistedDraft } from "@/lib/agent/writing-style";
import { and, desc, eq } from "drizzle-orm";
import { getEnv } from "@/lib/cloudflare";
import { getDb, type AppDatabase } from "@/db";
import { messages } from "@/db/schema";
import { requireSessionUser } from "@/lib/api/auth";
import type { SessionUser } from "@/lib/auth/types";
import { newId } from "@/lib/ids";
import { buildSnippet } from "@/lib/email/parse";
import { copyMessageAttachments } from "@/lib/email/attachments";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { isHiddenDraft } from "@/lib/messages/draft-privacy-utils";
import { getDraftSender, readDraftPayload } from "./utils";

export async function GET(request: Request) {
	const env = getEnv();
	const { user, error } = await requireSessionUser(env, request);
	if (error) return error;
	const url = new URL(request.url);
	const mailboxId = url.searchParams.get("mailboxId");
	const db = getDb(env);
	const conditions = [
		eq(messages.userId, user.id),
		eq(messages.direction, "outbound" as const),
		eq(messages.status, "draft"),
	];
	if (mailboxId) conditions.push(eq(messages.mailboxId, mailboxId));

	const rows = await db
		.select()
		.from(messages)
		.where(and(...conditions))
		.orderBy(desc(messages.createdAt))
		.limit(100);

	return NextResponse.json({ drafts: rows });
}

/** The id of the message a new draft forwards, when the user may read it; another user's draft is not found. */
async function readableForwardSource(db: AppDatabase, user: SessionUser, messageId: string): Promise<string | null> {
	const [source] = await db
		.select({ id: messages.id, mailboxId: messages.mailboxId, status: messages.status, userId: messages.userId })
		.from(messages)
		.where(eq(messages.id, messageId))
		.limit(1);
	if (!source?.mailboxId || isHiddenDraft(source, user.id)) return null;
	const access = await getMailboxAccessLevel(db, user, source.mailboxId);
	return access?.canRead ? source.id : null;
}

export async function POST(request: Request) {
	const env = getEnv();
	const { user, error } = await requireSessionUser(env, request);
	if (error) return error;
	const body = await readDraftPayload(request);
	if (body.response) return body.response;
	const { input } = body;
	const db = getDb(env);
	const sender = await getDraftSender(env, user.id, input, { connectedAccounts: true });
	if ("error" in sender) {
		return NextResponse.json({ error: sender.error }, { status: 403 });
	}
	// Forwarding: the source must be readable by this user before its files are copied.
	const forwardSourceId = input.forwardOfMessageId
		? await readableForwardSource(db, user, input.forwardOfMessageId)
		: null;
	if (input.forwardOfMessageId && !forwardSourceId) {
		return NextResponse.json({ error: "Message not found" }, { status: 404 });
	}

	const draftId = newId("msg");
	const text = input.text ?? "";
	const html = input.html ?? "";

	await db.insert(messages).values({
		id: draftId,
		userId: user.id,
		mailboxId: sender.mailboxId,
		direction: "outbound",
		fromAddr: sender.fromAddr,
		toAddr: input.to ?? "",
		ccAddr: input.cc || null,
		bccAddr: input.bcc || null,
		subject: input.subject ?? null,
		snippet: buildSnippet(text || null, html || null),
		textBody: text || null,
		htmlBody: html || null,
		status: "draft",
		read: true,
		inReplyTo: input.inReplyTo || null,
		references: input.references || null,
		threadId: input.threadId || null,
	});

	await markAiAssistedDraft(db, draftId, input.aiAssisted);
	const attachments = forwardSourceId ? await copyMessageAttachments(env, forwardSourceId, draftId) : [];
	return NextResponse.json({ draft: { id: draftId, attachments } });
}
