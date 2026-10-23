import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { requireSessionUser } from "@/lib/api/auth";
import { getEnv } from "@/lib/cloudflare";
import { getScreenerMessageStatus } from "@/lib/screener/views";

/** Whether the reader shows the Screener banner for a message. */
export async function GET(request: Request) {
	const env = getEnv();
	const { user, error } = await requireSessionUser(env, request);
	if (error) return error;
	const messageId = new URL(request.url).searchParams.get("messageId");
	if (!messageId) return NextResponse.json({ error: "Message is required" }, { status: 400 });
	const status = await getScreenerMessageStatus(getDb(env), user, messageId);
	if (!status) return NextResponse.json({ error: "Message not found" }, { status: 404 });
	return NextResponse.json(status);
}
