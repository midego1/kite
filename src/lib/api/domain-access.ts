import { NextResponse } from "next/server";
import { requireSessionAdmin } from "@/lib/api/auth";
import { canManageDomains } from "@/lib/auth/admin";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { getDomainForUser } from "@/lib/domains/service";

/**
 * The domain a session mutation changes: 401 without a session, 403 without domain
 * management or from another origin, 404 when the domain is not the user's.
 */
export async function requireManagedDomain(env: CloudflareEnv, request: Request, domainId: string) {
	const auth = await requireSessionAdmin(env, request, canManageDomains);
	if (auth.error) return { domain: null, error: auth.error } as const;
	if (!hasValidSessionMutationOrigin(request)) {
		return { domain: null, error: NextResponse.json({ error: "Invalid origin" }, { status: 403 }) } as const;
	}
	const domain = await getDomainForUser(env, auth.user.id, domainId);
	if (!domain) return { domain: null, error: NextResponse.json({ error: "Not found" }, { status: 404 }) } as const;
	return { user: auth.user, domain, error: null } as const;
}
