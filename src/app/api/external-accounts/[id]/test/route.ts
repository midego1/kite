import { postOnAccount } from "@/lib/external-accounts/http";
import { retestExternalAccount } from "@/lib/external-accounts/service";

type Params = { params: Promise<{ id: string }> };

/** **Test connection**: signs in with the saved password and records the outcome as the account's state. */
export async function POST(request: Request, { params }: Params) {
	return postOnAccount(request, params, (env, user, id) => retestExternalAccount(env, user, id));
}
