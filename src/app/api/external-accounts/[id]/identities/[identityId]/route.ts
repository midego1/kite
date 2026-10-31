import { onAccountIdentity } from "@/lib/external-accounts/http";
import { removeExternalIdentity } from "@/lib/external-accounts/identity-verification";

type Params = { params: Promise<{ id: string; identityId: string }> };

/** Removes an address from the account: Kite no longer sends as it. */
export async function DELETE(request: Request, { params }: Params) {
	return onAccountIdentity(request, params, (env, user, { id, identityId }) =>
		removeExternalIdentity(env, user, id, identityId),
	);
}
