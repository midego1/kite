import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getEnv } from "@/lib/cloudflare";
import { ACCOUNTS_COOKIE, rememberLogin } from "@/lib/auth/accounts";
import { createSession, SESSION_COOKIE } from "@/lib/auth/session";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { allowPasskeyAttempt } from "@/lib/auth/rate-limit";
import { recordAuthActivity } from "@/lib/auth/activity";
import { finishPasskeySignIn } from "@/lib/auth/passkeys";
import { passkeyFailure, tooManyAttempts, withPasskeys } from "@/lib/auth/passkey-http";
import { PASSKEY_CEREMONY_COOKIE, passkeyErrorMessage } from "@/lib/auth/passkey-utils";
import { readJsonBody } from "@/lib/http/request";
import { RequestBodyTooLargeError } from "@/lib/http/errors";
import { passkeySignInSchema } from "@/lib/validators";

/**
 * Finishes a passkey sign-in and opens a session. The passkey verified the user (PIN, biometrics), so it satisfies
 * two-factor authentication on its own and no TOTP code is asked for.
 */
export async function POST(request: Request) {
	const env = getEnv();
	let body: unknown;
	try {
		body = await readJsonBody(request, 64 * 1024);
	} catch (error) {
		const status = error instanceof RequestBodyTooLargeError ? 413 : 400;
		return NextResponse.json({ error: "Invalid sign-in request" }, { status });
	}
	const parsed = passkeySignInSchema.safeParse(body);
	if (!parsed.success) return NextResponse.json({ error: "Invalid passkey response" }, { status: 400 });
	if (!(await allowPasskeyAttempt(env, request))) return tooManyAttempts();
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

	const jar = await cookies();
	const ceremonyToken = jar.get(PASSKEY_CEREMONY_COOKIE)?.value;
	if (!ceremonyToken) {
		return NextResponse.json({ error: passkeyErrorMessage("challenge_mismatch"), code: "expired" }, { status: 401 });
	}
	return withPasskeys(async () => {
		const result = await finishPasskeySignIn(env, request, ceremonyToken, parsed.data.credential);
		if (!result.ok) {
			const failure = passkeyFailure(result);
			failure.cookies.delete({ name: PASSKEY_CEREMONY_COOKIE, path: "/api/auth/passkey" });
			return failure;
		}
		const { userId, passkeyName } = result.value;
		const token = await createSession(env, userId);
		await recordAuthActivity(env, { action: "auth.login", userId, request, details: { method: "passkey" } });
		await recordAuthActivity(env, { action: "auth.passkey_verified", userId, request, details: { passkeyName } });
		const response = NextResponse.json({ ok: true, userId, redirect: "/inbox", method: "passkey" });
		response.headers.set("Cache-Control", "no-store");
		response.cookies.delete({ name: PASSKEY_CEREMONY_COOKIE, path: "/api/auth/passkey" });
		response.cookies.set(SESSION_COOKIE, token, {
			httpOnly: true,
			secure: process.env.NODE_ENV === "production",
			sameSite: "lax",
			path: "/",
			maxAge: 60 * 60 * 24 * 30,
		});
		await rememberLogin(env, response, jar.get(ACCOUNTS_COOKIE)?.value, token, jar.get(SESSION_COOKIE)?.value);
		return response;
	});
}
