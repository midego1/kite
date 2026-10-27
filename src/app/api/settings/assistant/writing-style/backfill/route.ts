import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import { requireSessionUser } from "@/lib/api/auth";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { getEnv } from "@/lib/cloudflare";
import { readUserAiSettings } from "@/lib/agent/user-ai-settings";
import { requestStyleBackfill, writingStyleAvailable } from "@/lib/agent/writing-style";

const schema = z.object({ mailboxId: z.string().min(1).max(200) }).strict();

/** Queues a rebuild of one mailbox's profile from the user's last 200 composer sends there. */
export async function POST(request: Request) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
	const parsed = schema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) return NextResponse.json({ error: "Mailbox required" }, { status: 400 });
	if (!(await writingStyleAvailable(env)))
		return NextResponse.json(
			{ error: "Apply the pending database update first", code: "MIGRATION_PENDING" },
			{ status: 409 },
		);
	if (!(await readUserAiSettings(getDb(env), auth.user.id)).writingStyleEnabled)
		return NextResponse.json({ error: "Turn on Learn my writing style first" }, { status: 409 });
	const result = await requestStyleBackfill(env, auth.user, parsed.data.mailboxId);
	if (result === "not_found") return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
	if (result === "pending")
		return NextResponse.json({ error: "A backfill for this mailbox is already running" }, { status: 409 });
	return NextResponse.json({ queued: true }, { status: 202 });
}
