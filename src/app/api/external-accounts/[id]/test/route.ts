import { requireSessionUser } from "@/lib/api/auth";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { getEnv } from "@/lib/cloudflare";
import { answerExternal } from "@/lib/external-accounts/http";
import { retestExternalAccount } from "@/lib/external-accounts/service";

type Params = { params: Promise<{ id: string }> };

/** **Test connection**: signs in with the saved password and records the outcome as the account's state. */
export async function POST(request: Request, { params }: Params) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	if (!hasValidSessionMutationOrigin(request)) return Response.json({ error: "Invalid origin" }, { status: 403 });
	const { id } = await params;
	return answerExternal(async () => retestExternalAccount(env, auth.user, id));
}
