import { getEnv } from "@/lib/cloudflare";
import { requireSessionAdmin } from "@/lib/api/auth";
import { isPrimaryAdmin } from "@/lib/auth/admin";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { testAbuseChKey } from "@/lib/spam/providers/abuse-ch";
import { abuseChAuthKey } from "@/lib/spam/providers/abuse-ch-utils";

const NO_STORE = { "Cache-Control": "no-store" };

/** Owner only and POST only: one lookup of `example.com` per abuse.ch service with the configured key. */
export async function POST(request: Request) {
	const env = getEnv();
	const auth = await requireSessionAdmin(env, request, isPrimaryAdmin);
	if (auth.error) return auth.error;
	if (!hasValidSessionMutationOrigin(request))
		return Response.json({ error: "Invalid origin" }, { status: 403, headers: NO_STORE });
	const key = abuseChAuthKey(env);
	if (!key) return Response.json({ error: "No abuse.ch Auth-Key is set" }, { status: 400, headers: NO_STORE });
	return Response.json(await testAbuseChKey(key), { headers: NO_STORE });
}
