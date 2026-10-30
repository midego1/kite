import { NextResponse } from "next/server";
import { requireSessionUser } from "@/lib/api/auth";
import { getEnv } from "@/lib/cloudflare";
import { sendQueuedNow } from "@/lib/email/send";

export async function POST(request: Request, { params }: { params: Promise<{ messageId: string }> }) {
	const { messageId } = await params;
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;

	const result = await sendQueuedNow(env, auth.user.id, messageId);
	if (result.ok) return NextResponse.json({ ok: true });
	if (result.reason === "too_late") {
		return NextResponse.json({ error: "The message is already being sent" }, { status: 409 });
	}
	return NextResponse.json({ error: "Message not found" }, { status: 404 });
}
