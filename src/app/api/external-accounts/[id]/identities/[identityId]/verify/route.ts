import { onAccountIdentity } from "@/lib/external-accounts/http";
import { verifyExternalIdentity } from "@/lib/external-accounts/identity-verification";

type Params = { params: Promise<{ id: string; identityId: string }> };

/** Checks the 6-digit code mailed to the address; the right one lets the account send as it. */
export async function POST(request: Request, { params }: Params) {
	return onAccountIdentity(request, params, (env, user, { id, identityId }, body) =>
		verifyExternalIdentity(env, user, id, identityId, body),
	);
}
