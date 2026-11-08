import { startAuthRecheck } from "@/lib/external-accounts/auth-recheck";
import { postOnAccount } from "@/lib/external-accounts/http";
import { ownView } from "@/lib/external-accounts/service";

type Params = { params: Promise<{ id: string }> };

/**
 * **Recheck authentication** (spec §6.6.1): queues a re-read of a connected Gmail or Google Workspace account's own
 * recent mail for the authentication result Google added at delivery, for mail stored before that trust rule
 * existed. Only for an account eligible for it; `startAuthRecheck` refuses any other.
 */
export async function POST(request: Request, { params }: Params) {
	return postOnAccount(
		request,
		params,
		async (env, user, id) => {
			await startAuthRecheck(env, user, id);
			return { account: await ownView(env, user.id, id) };
		},
		{ status: 202 },
	);
}
