import { NextResponse } from "next/server";
import { requireSessionAdmin } from "@/lib/api/auth";
import { getEnv } from "@/lib/cloudflare";
import { getSearchIndexStatus, rebuildSearchIndex } from "@/lib/search/index-admin";

/** Row counts for the index versus the messages table, to spot drift. */
export async function GET(request: Request) {
	const env = getEnv();
	const auth = await requireSessionAdmin(env, request);
	if (auth.error) return auth.error;
	return NextResponse.json(await getSearchIndexStatus(env));
}

/** Re-index every message from the messages table. Safe to run at any time. */
export async function POST(request: Request) {
	const env = getEnv();
	const auth = await requireSessionAdmin(env, request);
	if (auth.error) return auth.error;
	await rebuildSearchIndex(env);
	return NextResponse.json(await getSearchIndexStatus(env));
}
