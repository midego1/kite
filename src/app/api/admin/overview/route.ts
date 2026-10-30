import { NextResponse } from "next/server";
import { requireSessionAdmin } from "@/lib/api/auth";
import { loadAdminOverviewCounts } from "@/lib/admin/overview";
import { getEnv } from "@/lib/cloudflare";

/** The counts on the admin overview for any admin; the primary-only and domain-only parts come back null otherwise. */
export async function GET(request: Request) {
	const env = getEnv();
	const auth = await requireSessionAdmin(env, request);
	if (auth.error) return auth.error;
	return NextResponse.json(await loadAdminOverviewCounts(env, auth.user), { headers: { "Cache-Control": "no-store" } });
}
