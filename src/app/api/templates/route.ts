import { and, desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { bodyBytesColumn, withStoredBodies } from "@/lib/messages/body-batches";
import { getDb } from "@/db";
import { messages } from "@/db/schema";
import { requireSessionUser } from "@/lib/api/auth";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { getEnv } from "@/lib/cloudflare";
import { newId } from "@/lib/ids";
import { buildSnippet } from "@/lib/email/parse";
import { getDraftSender } from "../drafts/utils";
import { withModule } from "@/lib/modules/route-guard";

// Templates are outbound messages with status "template": they look like drafts
// in the database but no draft, folder or count query ever selects them.
export const GET = withModule("templates", async (request, { checkUser }) => {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	const denied = await checkUser(auth.user);
	if (denied) return denied;
	const db = getDb(env);
	const listed = await db
		.select({ id: messages.id, subject: messages.subject, bodyBytes: bodyBytesColumn })
		.from(messages)
		.where(and(eq(messages.userId, auth.user.id), eq(messages.status, "template")))
		.orderBy(desc(messages.createdAt))
		.limit(200);
	// Bodies in bounded batches: 200 templates of any size could pass D1's 50 MB result limit in one query.
	const templates = await withStoredBodies(db, listed);
	return NextResponse.json({
		templates: templates.map((row) => ({
			id: row.id,
			subject: row.subject,
			htmlBody: row.htmlBody,
			textBody: row.textBody,
		})),
	});
});

export const POST = withModule("templates", async function POST(request, { checkAuth }) {
	const env = getEnv();
	const auth = await checkAuth(requireSessionUser(env, request));
	if (auth.error) return auth.error;
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
	const input = (await request.json().catch(() => null)) as {
		mailboxId?: string | null;
		from?: string;
		title?: string;
		html?: string;
		text?: string;
	} | null;
	const title = input?.title?.trim().slice(0, 200);
	const html = input?.html ?? "";
	const text = input?.text ?? "";
	if (!title || !(html.trim() || text.trim()))
		return NextResponse.json({ error: "Enter a title and content." }, { status: 400 });
	const sender = await getDraftSender(env, auth.user.id, { mailboxId: input?.mailboxId, from: input?.from });
	if ("error" in sender) return NextResponse.json({ error: sender.error }, { status: 403 });
	const id = newId("msg");
	await getDb(env)
		.insert(messages)
		.values({
			id,
			userId: auth.user.id,
			mailboxId: sender.mailboxId,
			direction: "outbound",
			fromAddr: sender.fromAddr,
			toAddr: "",
			subject: title,
			snippet: buildSnippet(text || null, html || null),
			textBody: text || null,
			htmlBody: html || null,
			status: "template",
			read: true,
		});
	return NextResponse.json(
		{ template: { id, subject: title, htmlBody: html || null, textBody: text || null } },
		{ status: 201 },
	);
});
