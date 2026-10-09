import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { requireSessionUser } from "@/lib/api/auth";
import { getEnv } from "@/lib/cloudflare";
import { blockContact } from "@/lib/contacts/service";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import type { BlockContactRequest } from "./types";

export async function POST(request: Request) {
	const env = getEnv();
	const { user, error } = await requireSessionUser(env, request);
	if (error) return error;
	const body = (await request.json()) as BlockContactRequest;
	if (!body.mailboxId || !body.address?.trim()) {
		return NextResponse.json({ error: "Mailbox and contact are required" }, { status: 400 });
	}

	const access = await getMailboxAccessLevel(getDb(env), user, body.mailboxId);
	if (!access?.canManage) {
		return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
	}

	const contact = await blockContact(env, {
		userId: access.mailbox.userId,
		mailboxId: access.mailbox.id,
		domainId: access.mailbox.domainId,
		address: body.address,
	});
	return NextResponse.json({ contact });
}
