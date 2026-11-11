import { NextResponse } from "next/server";
import { getEnv } from "@/lib/cloudflare";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { allowPasskeyAttempt } from "@/lib/auth/rate-limit";
import { beginPasskeySignIn } from "@/lib/auth/passkeys";
import { noStoreJson, tooManyAttempts, withPasskeys } from "@/lib/auth/passkey-http";
import { PASSKEY_CEREMONY_COOKIE, PASSKEY_CHALLENGE_TTL_MS } from "@/lib/auth/passkey-utils";

/**
 * Starts a passkey sign-in: options for `navigator.credentials.get()` with an empty allow list, so the browser
 * offers every passkey it has for this site (also as autofill). The ceremony token goes into an httpOnly cookie,
 * which ties the challenge to this browser.
 */
export async function POST(request: Request) {
	const env = getEnv();
	// Another site must not be able to replace this browser's ceremony cookie and break a sign-in in progress.
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
	if (!(await allowPasskeyAttempt(env, request))) return tooManyAttempts();
	return withPasskeys(async () => {
		const { token, options } = await beginPasskeySignIn(env, request);
		const response = noStoreJson({ options });
		response.cookies.set(PASSKEY_CEREMONY_COOKIE, token, {
			httpOnly: true,
			secure: process.env.NODE_ENV === "production",
			sameSite: "strict",
			path: "/api/auth/passkey",
			maxAge: Math.floor(PASSKEY_CHALLENGE_TTL_MS / 1000),
		});
		return response;
	});
}
