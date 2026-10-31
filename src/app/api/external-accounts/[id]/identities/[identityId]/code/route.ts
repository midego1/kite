import { onAccountIdentity } from "@/lib/external-accounts/http";
import { resendExternalIdentityCode } from "@/lib/external-accounts/identity-verification";

type Params = { params: Promise<{ id: string; identityId: string }> };

/** **Send a new code** to an address that is not verified yet; the earlier code stops working. */
export async function POST(request: Request, { params }: Params) {
	return onAccountIdentity(request, params, (env, user, { id, identityId }) =>
		resendExternalIdentityCode(env, user, id, identityId),
	);
}
