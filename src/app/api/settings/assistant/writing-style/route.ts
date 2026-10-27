import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { requireSessionUser } from "@/lib/api/auth";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { getEnv } from "@/lib/cloudflare";
import { readUserAiSettings } from "@/lib/agent/user-ai-settings";
import { listStyleProfiles, resetStyleProfile, writingStyleAvailable } from "@/lib/agent/writing-style";

const NO_STORE = { "Cache-Control": "no-store" };

/** The user's own profiles, one per mailbox they can send from, with exactly the text Kite tells the AI. */
export async function GET(request: Request) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	const db = getDb(env);
	if (!(await writingStyleAvailable(env)) || !(await readUserAiSettings(db, auth.user.id)).writingStyleEnabled)
		return NextResponse.json({ profiles: [] }, { headers: NO_STORE });
	return NextResponse.json({ profiles: await listStyleProfiles(db, auth.user) }, { headers: NO_STORE });
}

/** Reset: deletes the profile of one mailbox (`?mailboxId=`). */
export async function DELETE(request: Request) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
	const mailboxId = new URL(request.url).searchParams.get("mailboxId");
	if (!mailboxId) return NextResponse.json({ error: "Mailbox required" }, { status: 400 });
	if (!(await writingStyleAvailable(env)))
		return NextResponse.json(
			{ error: "Apply the pending database update first", code: "MIGRATION_PENDING" },
			{ status: 409 },
		);
	await resetStyleProfile(getDb(env), auth.user.id, mailboxId);
	return NextResponse.json({ ok: true });
}
