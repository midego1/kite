import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { requireSessionUser } from "@/lib/api/auth";
import { getEnv } from "@/lib/cloudflare";
import { MessageBodyUnavailableError } from "@/lib/email/bodies";
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

	let mbox: string;
	try {
		mbox = await exportMailboxToMbox(env, mailboxId, user.id);
	} catch (failure) {
		if (!(failure instanceof MessageBodyUnavailableError)) throw failure;
		return NextResponse.json(
			{ error: "Some messages could not be read from mail storage. Try the export again.", code: "BODY_UNAVAILABLE" },
			{ status: 503 },
		);
	}
	const address = `${access.mailbox.localPart}.mbox`;
	return new Response(mbox, {
		headers: {
			"Content-Type": "application/mbox; charset=utf-8",
			"Content-Disposition": `attachment; filename="${address}"`,
			"Cache-Control": "no-store",
		},
	});
}
