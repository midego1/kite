import { requireSessionUser } from "@/lib/api/auth";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { getEnv } from "@/lib/cloudflare";
import { answerExternal } from "@/lib/external-accounts/http";
import { startMicrosoftSignIn } from "@/lib/external-accounts/oauth-flow";
import { readJsonBody } from "@/lib/http/request";

/**
 * **Sign in with Microsoft** (spec §15.2): checks the Kite password and the mailbox, stores a single-use state, and
 * answers the URL of Microsoft's sign-in page, which the browser opens. `accountId` reconnects that account.
 */
export async function POST(request: Request) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	if (!hasValidSessionMutationOrigin(request)) return Response.json({ error: "Invalid origin" }, { status: 403 });
	const body = await readJsonBody<Record<string, unknown>>(request, 16 * 1024).catch(() => null);
	if (!body || typeof body !== "object") return Response.json({ error: "Invalid request" }, { status: 400 });
	if (body.provider !== "microsoft") return Response.json({ error: "Unknown sign-in provider" }, { status: 400 });
	return answerExternal(() => startMicrosoftSignIn(env, auth.user, body, new URL(request.url).origin));
}
