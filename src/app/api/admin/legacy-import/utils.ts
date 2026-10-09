import { NextResponse } from "next/server";
import { requireSessionAdmin } from "@/lib/api/auth";
import { isPrimaryAdmin } from "@/lib/auth/admin";
import { getEnv } from "@/lib/cloudflare";
import { LegacyImportError } from "@/lib/legacy-import/service";

export function hasSameOrigin(request: Request): boolean {
	return request.headers.get("Origin") === new URL(request.url).origin;
}

export function invalidOrigin() {
	return NextResponse.json({ error: "Invalid request origin" }, { status: 403 });
}

/** The primary admin's session, and for anything but GET a same-origin request. */
export async function authorizeLegacyImportRequest(request: Request) {
	const env = getEnv();
	const auth = await requireSessionAdmin(env, request, isPrimaryAdmin);
	if (auth.error) return { error: auth.error } as const;
	if (request.method !== "GET" && !hasSameOrigin(request)) return { error: invalidOrigin() } as const;
	return { env, user: auth.user } as const;
}

export function legacyImportErrorResponse(error: unknown, fallback: string) {
	if (error instanceof LegacyImportError) return NextResponse.json({ error: error.message }, { status: error.status });
	return NextResponse.json({ error: error instanceof Error ? error.message : fallback }, { status: 500 });
}
