import { requireSessionUser } from "@/lib/api/auth";
import { getEnv } from "@/lib/cloudflare";
import { answerExternal } from "@/lib/external-accounts/http";
import { listAccountsNeedingAttention } from "@/lib/external-accounts/attention";

/** The user's connected accounts that need them (sign-in, certificate or lasting errors), for the sidebar notice. */
export async function GET(request: Request) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	return answerExternal(async () => ({ accounts: await listAccountsNeedingAttention(env, auth.user.id) }), {
		whenPending: { accounts: [] },
	});
}
