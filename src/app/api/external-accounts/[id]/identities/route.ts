import { onAccountIdentity } from "@/lib/external-accounts/http";
import { addExternalIdentity } from "@/lib/external-accounts/identity-verification";

type Params = { params: Promise<{ id: string }> };

/** Adds an address the account may send as once verified, and mails it a 6-digit code (spec §7.2). */
export async function POST(request: Request, { params }: Params) {
	return onAccountIdentity(request, params, (env, user, { id }, body) => addExternalIdentity(env, user, id, body), {
		status: 201,
	});
}
