import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { getDb } from "@/db";
import { messages } from "@/db/schema";
import {
	SEND_PENDING_MOVE_MESSAGE,
	SEND_PENDING_MOVE_REFUSED,
	isMoveRefusedWhileSending,
} from "@/lib/messages/send-state-utils";
import { getEnv } from "@/lib/cloudflare";
import { getCurrentUser } from "@/lib/auth/cookies";
import { updateMessageStatusForUser } from "@/lib/user";
import type { MessageStatusPayload } from "./types";
import { isAllowedMessageStatus } from "./utils";

export async function POST(request: Request, { params }: { params: Promise<{ messageId: string }> }) {
	const { messageId } = await params;
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	const payload = (await request.json()) as MessageStatusPayload;
	if (!isAllowedMessageStatus(payload.status)) {
		return NextResponse.json({ error: "Invalid message status" }, { status: 400 });
	}

	const db = getDb(env);
	const [current] = await db
		.select({ status: messages.status, mailboxId: messages.mailboxId })
		.from(messages)
		.where(eq(messages.id, messageId))
		.limit(1);
	// Only someone who could have moved it is told why not; anyone else gets the usual 404.
	if (
		current?.mailboxId &&
		isMoveRefusedWhileSending("move", current.status) &&
		(await getMailboxAccessLevel(db, user, current.mailboxId))?.canManage
	) {
		return NextResponse.json({ error: SEND_PENDING_MOVE_MESSAGE, code: SEND_PENDING_MOVE_REFUSED }, { status: 409 });
	}

	const success = await updateMessageStatusForUser(env, user, messageId, payload.status);
	if (!success) {
		return NextResponse.json({ error: "Message not found" }, { status: 404 });
	}

	return NextResponse.json({ success: true });
}
