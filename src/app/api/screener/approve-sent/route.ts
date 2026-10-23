import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { requireSessionUser } from "@/lib/api/auth";
import { getEnv } from "@/lib/cloudflare";
import { approveEveryoneWrittenTo } from "@/lib/screener/service";
import { readBody, resolveScreenerMailbox, screenerErrorResponse } from "../utils";

/** The one-time "Approve everyone you've written to" offered when the Screener is turned on. */
export async function POST(request: Request) {
	const env = getEnv();
	const { user, error } = await requireSessionUser(env, request);
	if (error) return error;
	const body = (await readBody(request)) as { mailboxId?: unknown } | null;
	const mailboxId = typeof body?.mailboxId === "string" ? body.mailboxId : null;
	const resolved = await resolveScreenerMailbox(getDb(env), user, mailboxId, true);
	if (resolved.error) return resolved.error;
	try {
		return NextResponse.json(await approveEveryoneWrittenTo(env, user, resolved.access));
	} catch (caught) {
		return screenerErrorResponse(caught);
	}
}
