import { requireSessionUser } from "@/lib/api/auth";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { getEnv } from "@/lib/cloudflare";
import { answerExternal } from "@/lib/external-accounts/http";
import { checkExternalAccountNow } from "@/lib/external-accounts/service";

type Params = { params: Promise<{ id: string }> };

/** **Check now**: queues a check of the account for new mail, at most once a minute. */
export async function POST(request: Request, { params }: Params) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	if (!hasValidSessionMutationOrigin(request)) return Response.json({ error: "Invalid origin" }, { status: 403 });
	const { id } = await params;
	return answerExternal(async () => ({ account: await checkExternalAccountNow(env, auth.user, id) }), {
		status: 202,
	});
}
