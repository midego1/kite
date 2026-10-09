import { NextResponse } from "next/server";
import { requireSessionAdmin } from "@/lib/api/auth";
import { isPrimaryAdmin } from "@/lib/auth/admin";
import { getEnv } from "@/lib/cloudflare";

async function authorizeAdminRequest(request: Request) {
	const env = getEnv();
	const auth = await requireSessionAdmin(env, request, isPrimaryAdmin);
	if (auth.error) return { error: auth.error };
	return { env };
}

export async function authorizeMigrationRequest(request: Request) {
	const authorization = await authorizeAdminRequest(request);
	if ("error" in authorization) return authorization;
	if (request.method !== "GET" && request.headers.get("Origin") !== new URL(request.url).origin) {
		return { error: NextResponse.json({ error: "Invalid request origin" }, { status: 403 }) };
	}
	return authorization;
}
