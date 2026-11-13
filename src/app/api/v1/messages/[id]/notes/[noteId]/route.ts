import { NextResponse } from "next/server";
import { authenticateApiKey, requireScope } from "@/lib/api/auth";
import { getEnv } from "@/lib/cloudflare";
import { respondDeleteNote, respondUpdateNote } from "@/lib/notes/http";

type RouteParams = { params: Promise<{ id: string; noteId: string }> };

/** Replaces the text of a note the key's user wrote (`notes` scope). */
export async function PATCH(request: Request, { params }: RouteParams) {
	const env = getEnv();
	const auth = await authenticateApiKey(env, request.headers.get("authorization"));
	if (!auth || !requireScope(auth.scopes, "notes"))
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	const { id, noteId } = await params;
	return respondUpdateNote(
		env,
		{ user: auth.user, mailboxIds: auth.mailboxIds, hideScreening: true },
		id,
		noteId,
		request,
	);
}

/** Deletes a note (`notes` scope): the key's user wrote it, or has full access to the mailbox. */
export async function DELETE(request: Request, { params }: RouteParams) {
	const env = getEnv();
	const auth = await authenticateApiKey(env, request.headers.get("authorization"));
	if (!auth || !requireScope(auth.scopes, "notes"))
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	const { id, noteId } = await params;
	return respondDeleteNote(env, { user: auth.user, mailboxIds: auth.mailboxIds, hideScreening: true }, id, noteId);
}
