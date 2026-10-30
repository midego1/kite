import { postOnAccount } from "@/lib/external-accounts/http";
import { checkExternalAccountNow } from "@/lib/external-accounts/service";

type Params = { params: Promise<{ id: string }> };

/** **Check now**: queues a check of the account for new mail, at most once a minute. */
export async function POST(request: Request, { params }: Params) {
	return postOnAccount(
		request,
		params,
		async (env, user, id) => ({ account: await checkExternalAccountNow(env, user, id) }),
		{ status: 202 },
	);
}
