import { requireSessionUser } from "@/lib/api/auth";
import { getEnv } from "@/lib/cloudflare";
import { completeOAuthSignIn } from "@/lib/external-accounts/oauth-flow";
import { oauthResultPath } from "@/lib/external-accounts/oauth-result-utils";

const NO_STORE = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };

/** Back to the Connected accounts page, saying how the sign-in went; never with the code or the state. */
function backToSettings(request: Request, path: string): Response {
	return new Response(null, { status: 303, headers: { ...NO_STORE, Location: new URL(path, request.url).toString() } });
}

/**
 * Where Microsoft and Google send the browser back after sign-in (`${APP_URL}/api/external-accounts/oauth/callback`,
 * spec §15.1); the state says which provider it was.
 * The state is single-use and belongs to the signed-in user who started the sign-in, so this link cannot be used by
 * anyone else, or twice. Without a session it answers 401 like any other API route.
 */
export async function GET(request: Request) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	// Like every other API route, no session is a 401: nothing about the state is read or used without one.
	if (auth.error) return auth.error;
	const outcome = await completeOAuthSignIn(env, auth.user, new URL(request.url).searchParams);
	return backToSettings(request, oauthResultPath(outcome));
}
