import { requireSessionUser } from "@/lib/api/auth";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { getEnv } from "@/lib/cloudflare";
import { answerExternal } from "@/lib/external-accounts/http";
import { startOAuthSignIn } from "@/lib/external-accounts/oauth-flow";
import { isOAuthProvider } from "@/lib/external-accounts/oauth-provider-utils";
import { readJsonBody } from "@/lib/http/request";

/**
 * **Sign in with Microsoft** or **Sign in with Google** (spec §15.2, §15.7): checks the Kite password and the mailbox,
 * stores a single-use state, and answers the URL of the provider's sign-in page, which the browser opens. `accountId`
 * reconnects that account.
 */
export async function POST(request: Request) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	if (!hasValidSessionMutationOrigin(request)) return Response.json({ error: "Invalid origin" }, { status: 403 });
	const body = await readJsonBody<Record<string, unknown>>(request, 16 * 1024).catch(() => null);
	if (!body || typeof body !== "object") return Response.json({ error: "Invalid request" }, { status: 400 });
	const provider = body.provider;
	if (!isOAuthProvider(provider)) return Response.json({ error: "Unknown sign-in provider" }, { status: 400 });
	return answerExternal(() => startOAuthSignIn(env, auth.user, provider, body, new URL(request.url).origin));
}
