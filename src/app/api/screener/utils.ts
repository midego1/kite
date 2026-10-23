import { NextResponse } from "next/server";
import type { AppDatabase } from "@/db";
import type { SessionUser } from "@/lib/auth/types";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import type { MailboxAccessLevel } from "@/lib/mailboxes/types";
import { ScreenerUnavailableError } from "@/lib/screener/settings";

type Resolved = { access: MailboxAccessLevel; error: null } | { access: null; error: NextResponse };

/** The mailbox a Screener request names: 404 when the user cannot read it, 403 when a change needs full access. */
export async function resolveScreenerMailbox(
	db: AppDatabase,
	user: SessionUser,
	mailboxId: string | null | undefined,
	manage: boolean,
): Promise<Resolved> {
	if (!mailboxId) return { access: null, error: NextResponse.json({ error: "Mailbox is required" }, { status: 400 }) };
	const access = await getMailboxAccessLevel(db, user, mailboxId);
	if (!access?.canRead)
		return { access: null, error: NextResponse.json({ error: "Mailbox not found" }, { status: 404 }) };
	if (manage && !access.canManage)
		return {
			access: null,
			error: NextResponse.json({ error: "Only people with full access can change the Screener" }, { status: 403 }),
		};
	return { access, error: null };
}

/** Before migration 0067 a change answers 503 with the reason instead of failing with a database error. */
export function screenerErrorResponse(error: unknown): NextResponse {
	if (error instanceof ScreenerUnavailableError)
		return NextResponse.json({ error: error.message, code: "SCREENER_UNAVAILABLE" }, { status: 503 });
	throw error;
}

export async function readBody(request: Request): Promise<unknown> {
	return request.json().catch(() => null);
}
