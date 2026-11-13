import { requireSessionUser } from "@/lib/api/auth";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { getEnv } from "@/lib/cloudflare";
import { respondDeleteNote, respondUpdateNote } from "@/lib/notes/http";

type RouteParams = { params: Promise<{ messageId: string; noteId: string }> };

/** Replaces the text of the caller's own note (`{ body }`). A note of another conversation is not found. */
export async function PATCH(request: Request, { params }: RouteParams) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	if (!hasValidSessionMutationOrigin(request)) return Response.json({ error: "Invalid origin" }, { status: 403 });
	const { messageId, noteId } = await params;
	return respondUpdateNote(
		env,
		{ user: auth.user, mailboxIds: null, hideScreening: false },
		messageId,
		noteId,
		request,
	);
}

/** Deletes a note: its author, or someone with full access to the mailbox. */
export async function DELETE(request: Request, { params }: RouteParams) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	if (!hasValidSessionMutationOrigin(request)) return Response.json({ error: "Invalid origin" }, { status: 403 });
	const { messageId, noteId } = await params;
	return respondDeleteNote(env, { user: auth.user, mailboxIds: null, hideScreening: false }, messageId, noteId);
}
