import { NextResponse } from "next/server";
import { requireSessionUser } from "@/lib/api/auth";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { getEnv } from "@/lib/cloudflare";
import { unsubscribeOneClick } from "@/lib/email/one-click-unsubscribe";
import type { UnsubscribeRouteParams } from "./types";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * One-click unsubscribe (RFC 8058) from the list the message came from. Kite sends the POST itself, to the URL in the
 * message's own signed `List-Unsubscribe` header; the request carries no body. When the message offers no verified
 * one-click, or the sender's endpoint fails, the answer carries the link the reader can still open (`url`).
 */
export async function POST(request: Request, { params }: UnsubscribeRouteParams) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	if (!hasValidSessionMutationOrigin(request))
		return NextResponse.json({ error: "Invalid origin" }, { status: 403, headers: NO_STORE });

	const { messageId } = await params;
	const result = await unsubscribeOneClick(env, auth.user, messageId);
	switch (result.kind) {
		case "done":
			return NextResponse.json({ unsubscribed: true }, { headers: NO_STORE });
		case "not_found":
			return NextResponse.json({ error: "Message not found" }, { status: 404, headers: NO_STORE });
		case "forbidden":
			return NextResponse.json(
				{ error: "You need full access to this mailbox to unsubscribe" },
				{ status: 403, headers: NO_STORE },
			);
		case "rate_limited":
			return NextResponse.json(
				{ error: "Too many unsubscribe requests. Try again in a minute.", code: "RATE_LIMITED" },
				{ status: 429, headers: NO_STORE },
			);
		case "duplicate":
			return NextResponse.json(
				{
					error: "Kite already sent this unsubscribe request a few minutes ago.",
					code: "ALREADY_REQUESTED",
					url: result.url,
				},
				{ status: 429, headers: NO_STORE },
			);
		case "unavailable":
			return NextResponse.json(
				{ error: "This message does not offer one-click unsubscribe", code: "ONE_CLICK_UNAVAILABLE", url: result.url },
				{ status: 409, headers: NO_STORE },
			);
		case "failed":
			return NextResponse.json(
				{ error: "The sender did not confirm the unsubscribe", code: "UNSUBSCRIBE_FAILED", url: result.url },
				{ status: 502, headers: NO_STORE },
			);
	}
}
