import { requireSessionUser } from "@/lib/api/auth";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { getEnv } from "@/lib/cloudflare";
import { respondAddNote, respondListNotes } from "@/lib/notes/http";

type RouteParams = { params: Promise<{ messageId: string }> };

/**
 * The internal notes on the conversation of `messageId`, oldest first: anyone who can read the mailbox reads them.
 * Before migration 0115 the list is empty with `migrationPending: true`.
 */
export async function GET(request: Request, { params }: RouteParams) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	return respondListNotes(
		env,
		{ user: auth.user, mailboxIds: null, hideScreening: false, via: "session" },
		(await params).messageId,
	);
}

/** Adds a note (`{ body, aboutMessage? }`); read-only access answers 403, before migration 0115 409 `MIGRATION_PENDING`. */
export async function POST(request: Request, { params }: RouteParams) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	if (!hasValidSessionMutationOrigin(request)) return Response.json({ error: "Invalid origin" }, { status: 403 });
	return respondAddNote(
		env,
		{ user: auth.user, mailboxIds: null, hideScreening: false, via: "session" },
		(await params).messageId,
		request,
	);
}
