import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth/admin";
import { getCurrentUser } from "@/lib/auth/cookies";
import type { SessionUser } from "@/lib/auth/types";
import { authenticateApiKeyValue, hasScope } from "@/lib/api/key-auth";
import type { ApiAuthResult } from "@/lib/api/key-auth-types";

export type { ApiAuthResult };

export async function authenticateApiKey(
	env: CloudflareEnv,
	authorization: string | null,
): Promise<ApiAuthResult | null> {
	if (!authorization?.startsWith("Bearer ")) return null;
	return authenticateApiKeyValue(env, authorization.slice(7));
}

export const requireScope = hasScope;

/**
 * Session auth for route handlers. `requireUser` throws a bare Error, which Next turns into
 * a 500; this returns a proper 401 response instead so unauthenticated callers get the right
 * status.
 */
export async function requireSessionUser(env: CloudflareEnv, request: Request) {
	const user = await getCurrentUser(env, request);
	if (!user) {
		return { user: null, error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) } as const;
	}
	return { user, error: null } as const;
}

/**
 * Session auth plus a role check: 401 without a session, 403 when `allow` rejects the user.
 * Pass `isPrimaryAdmin` (or another predicate from `@/lib/auth/admin`) for owner-only routes.
 */
export async function requireSessionAdmin(
	env: CloudflareEnv,
	request: Request,
	allow: (user: SessionUser) => boolean = isAdmin,
) {
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth;
	if (!allow(auth.user)) {
		return { user: null, error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) } as const;
	}
	return { user: auth.user, error: null } as const;
}
