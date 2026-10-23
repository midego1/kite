import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { requireSessionUser } from "@/lib/api/auth";
import { getEnv } from "@/lib/cloudflare";
import { createAuditLog } from "@/lib/mailboxes/audit";
import { parseScreenerSettingsPatch } from "@/lib/screener/screener-utils";
import { saveScreenerSettings } from "@/lib/screener/settings";
import { getScreenerOverview } from "@/lib/screener/views";
import { readBody, resolveScreenerMailbox, screenerErrorResponse } from "./utils";

export async function GET(request: Request) {
	const env = getEnv();
	const { user, error } = await requireSessionUser(env, request);
	if (error) return error;
	const db = getDb(env);
	const mailboxId = new URL(request.url).searchParams.get("mailboxId");
	const resolved = await resolveScreenerMailbox(db, user, mailboxId, false);
	if (resolved.error) return resolved.error;
	return NextResponse.json(await getScreenerOverview(db, resolved.access));
}

export async function PATCH(request: Request) {
	const env = getEnv();
	const { user, error } = await requireSessionUser(env, request);
	if (error) return error;
	const parsed = parseScreenerSettingsPatch(await readBody(request));
	if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
	const db = getDb(env);
	const resolved = await resolveScreenerMailbox(db, user, parsed.value.mailboxId, true);
	if (resolved.error) return resolved.error;
	const { mailboxId, ...patch } = parsed.value;
	try {
		await saveScreenerSettings(db, mailboxId, patch, user.id);
	} catch (caught) {
		return screenerErrorResponse(caught);
	}
	await createAuditLog(env, { actorUserId: user.id, mailboxId, action: "screener.settings", metadata: patch });
	return NextResponse.json(await getScreenerOverview(db, resolved.access));
}
