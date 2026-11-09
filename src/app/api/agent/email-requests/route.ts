import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { requireSessionUser } from "@/lib/api/auth";
import { getEnv } from "@/lib/cloudflare";
import { listEmailRequests } from "@/lib/agent/email/requests-list";

export async function GET(request: Request) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	const requests = await listEmailRequests(getDb(env), auth.user.id);
	return NextResponse.json({ requests });
}
