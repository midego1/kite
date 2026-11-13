import { NextResponse } from "next/server";
import { authenticateApiKey, requireScope } from "@/lib/api/auth";
import { getEnv } from "@/lib/cloudflare";
import { respondAddNote, respondListNotes } from "@/lib/notes/http";

type RouteParams = { params: Promise<{ id: string }> };

/** The internal notes on the conversation of a message, oldest first (`read` scope). */
export async function GET(request: Request, { params }: RouteParams) {
	const env = getEnv();
	const auth = await authenticateApiKey(env, request.headers.get("authorization"));
	if (!auth || !requireScope(auth.scopes, "read")) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	return respondListNotes(
		env,
		{ user: auth.user, mailboxIds: auth.mailboxIds, hideScreening: true, via: "api_key" },
		(await params).id,
	);
}

/** Adds a note to the conversation of a message (`notes` scope), as the key's user. */
export async function POST(request: Request, { params }: RouteParams) {
	const env = getEnv();
	const auth = await authenticateApiKey(env, request.headers.get("authorization"));
	if (!auth || !requireScope(auth.scopes, "notes"))
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	return respondAddNote(
		env,
		{ user: auth.user, mailboxIds: auth.mailboxIds, hideScreening: true, via: "api_key" },
		(await params).id,
		request,
	);
}
