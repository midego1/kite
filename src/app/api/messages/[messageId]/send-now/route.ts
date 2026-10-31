import { NextResponse } from "next/server";
import { getSendErrorStatus } from "@/app/api/send/error-utils";
import { requireSessionUser } from "@/lib/api/auth";
import { getEnv } from "@/lib/cloudflare";
import { sendQueuedNow } from "@/lib/email/queued-send";

export async function POST(request: Request, { params }: { params: Promise<{ messageId: string }> }) {
	const { messageId } = await params;
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;

	let result: Awaited<ReturnType<typeof sendQueuedNow>>;
	try {
		result = await sendQueuedNow(env, auth.user.id, messageId);
	} catch (err) {
		// The provider refused it: the message is marked failed (back to Drafts with Undo), so say so.
		const message = err instanceof Error ? err.message : "Send failed";
		return NextResponse.json({ error: message, failed: true }, { status: getSendErrorStatus(message) });
	}
	if (result.ok) return NextResponse.json({ ok: true });
	if (result.reason === "held") {
		return NextResponse.json(
			{ error: "Could not send now. The message is still held and will be sent." },
			{ status: 500 },
		);
	}
	if (result.reason === "retrying") {
		return NextResponse.json(
			{ error: "The mail server asked to try later. Kite will retry the send." },
			{ status: 409 },
		);
	}
	if (result.reason === "too_late") {
		return NextResponse.json({ error: "The message is already being sent" }, { status: 409 });
	}
	return NextResponse.json({ error: "Message not found" }, { status: 404 });
}
