import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { requireSessionUser } from "@/lib/api/auth";
import { getEnv } from "@/lib/cloudflare";
import { parseScreenerSenderRemoval, parseScreenerSenderRequest } from "@/lib/screener/screener-utils";
import { approveSender, denySender, removeSenderDecision } from "@/lib/screener/service";
import { readBody, resolveScreenerMailbox, screenerErrorResponse } from "../utils";

/** Approve or deny a sender for one mailbox; approving releases their held mail, denying blocks them. */
export async function POST(request: Request) {
	const env = getEnv();
	const { user, error } = await requireSessionUser(env, request);
	if (error) return error;
	const parsed = parseScreenerSenderRequest(await readBody(request));
	if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
	const resolved = await resolveScreenerMailbox(getDb(env), user, parsed.value.mailboxId, true);
	if (resolved.error) return resolved.error;
	try {
		const result =
			parsed.value.decision === "approved"
				? await approveSender(env, user, resolved.access, parsed.value.address)
				: await denySender(env, user, resolved.access, parsed.value.address);
		return NextResponse.json(result);
	} catch (caught) {
		return screenerErrorResponse(caught);
	}
}

/** Forget a decision, from the settings lists or as the undo of an approval. */
export async function DELETE(request: Request) {
	const env = getEnv();
	const { user, error } = await requireSessionUser(env, request);
	if (error) return error;
	const parsed = parseScreenerSenderRemoval(await readBody(request));
	if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
	const resolved = await resolveScreenerMailbox(getDb(env), user, parsed.value.mailboxId, true);
	if (resolved.error) return resolved.error;
	try {
		return NextResponse.json(
			await removeSenderDecision(env, user, resolved.access, parsed.value.address, parsed.value.restoreMessageIds),
		);
	} catch (caught) {
		return screenerErrorResponse(caught);
	}
}
