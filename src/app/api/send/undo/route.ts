import { NextResponse } from "next/server";
import { requireSessionUser } from "@/lib/api/auth";
import { getEnv } from "@/lib/cloudflare";
import { cancelQueuedSend } from "@/lib/email/send";
import { undoSendSchema } from "@/lib/validators";

export async function POST(request: Request) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;

	const parsed = undoSendSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

	const result = await cancelQueuedSend(env, auth.user.id, parsed.data.messageId);
	if (result.ok) return NextResponse.json({ draftId: result.draftId });
	if (result.reason === "too_late") {
		return NextResponse.json({ error: "The message has already been sent" }, { status: 409 });
	}
	return NextResponse.json({ error: "Message not found" }, { status: 404 });
}
