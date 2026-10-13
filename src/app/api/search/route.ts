import { NextResponse } from "next/server";
import { requireSessionUser } from "@/lib/api/auth";
import { getEnv } from "@/lib/cloudflare";
import { searchModules } from "@/lib/search/module-search";
import { parseSearchLimit } from "@/lib/search/module-search-utils";
import { getRequestTimeZone } from "@/lib/time/utils";

const MAX_QUERY_LENGTH = 300;

/** Sections from the modules the signed-in user can use. Mail results come from the message list, not here. */
export async function GET(request: Request) {
	const env = getEnv();
	const { user, error } = await requireSessionUser(env, request);
	if (error) return error;
	const params = new URL(request.url).searchParams;
	const query = (params.get("q") ?? "").trim().slice(0, MAX_QUERY_LENGTH);
	if (!query) return NextResponse.json({ sections: [] });
	const timeZone = getRequestTimeZone(request, user.timeZone);
	const sections = await searchModules(env, user, query, parseSearchLimit(params.get("limit")), timeZone);
	return NextResponse.json({ sections });
}
