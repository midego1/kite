import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { requireSessionUser } from "@/lib/api/auth";
import { getEnv } from "@/lib/cloudflare";
import { exportMailboxToMbox } from "@/lib/export/mbox";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";

export async function GET(request: Request) {
	const env = getEnv();
	const { user, error } = await requireSessionUser(env, request);
	if (error) return error;
	const url = new URL(request.url);
	const mailboxId = url.searchParams.get("mailboxId");
	if (!mailboxId) return NextResponse.json({ error: "Mailbox is required" }, { status: 400 });

	const access = await getMailboxAccessLevel(getDb(env), user, mailboxId);
	if (!access?.canRead) {
		return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
	}

	const mbox = await exportMailboxToMbox(env, mailboxId);
	const address = `${access.mailbox.localPart}.mbox`;
	return new Response(mbox, {
		headers: {
			"Content-Type": "application/mbox; charset=utf-8",
			"Content-Disposition": `attachment; filename="${address}"`,
			"Cache-Control": "no-store",
		},
	});
}
