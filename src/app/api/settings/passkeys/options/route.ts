import { getEnv } from "@/lib/cloudflare";
import { getSessionTokenFromRequestHeaders } from "@/lib/auth/session";
import { beginPasskeyRegistration } from "@/lib/auth/passkeys";
import { noStoreJson, passkeyFailure, requirePasskeyReauthentication, withPasskeys } from "@/lib/auth/passkey-http";

/** Re-checks the password (or an authenticator code), then returns options for `navigator.credentials.create()`. */
export async function POST(request: Request) {
	const env = getEnv();
	const auth = await requirePasskeyReauthentication(env, request);
	if (auth.error) return auth.error;
	return withPasskeys(async () => {
		const result = await beginPasskeyRegistration(env, request, auth.user, getSessionTokenFromRequestHeaders(request));
		if (!result.ok) return passkeyFailure(result);
		return noStoreJson(result.value);
	});
}
