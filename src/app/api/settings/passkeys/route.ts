import { NextResponse } from "next/server";
import { getEnv } from "@/lib/cloudflare";
import { isAdmin } from "@/lib/auth/admin";
import { appUrlPasskeyWarning } from "@/lib/auth/passkey-utils";
import { requireSessionUser } from "@/lib/api/auth";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { allowPasskeyAttempt } from "@/lib/auth/rate-limit";
import { recordAuthActivity } from "@/lib/auth/activity";
import { noticeSignInChange } from "@/lib/auth/sign-in-notice";
import { getSessionTokenFromRequestHeaders } from "@/lib/auth/session";
import { finishPasskeyRegistration, listPasskeys, PasskeysUnavailableError } from "@/lib/auth/passkeys";
import { noStoreJson, passkeyFailure, tooManyAttempts, withPasskeys } from "@/lib/auth/passkey-http";
import { readJsonBody } from "@/lib/http/request";
import { passkeyRegistrationSchema } from "@/lib/validators";

/** The signed-in user's passkeys; `available: false` until migration 0112 is applied. */
export async function GET(request: Request) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	try {
		// Only admins can set APP_URL, so only they are told it is missing.
		const appUrlWarning = isAdmin(auth.user) ? appUrlPasskeyWarning(env.APP_URL) : null;
		return noStoreJson({ available: true, passkeys: await listPasskeys(env, auth.user.id), appUrlWarning });
	} catch (error) {
		if (error instanceof PasskeysUnavailableError) return noStoreJson({ available: false, passkeys: [] });
		throw error;
	}
}

/**
 * Finishes adding a passkey. The re-authentication happened when the options were issued: their challenge is
 * bound to this user and session, single-use and five minutes old at most.
 */
export async function POST(request: Request) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
	if (!(await allowPasskeyAttempt(env, request))) return tooManyAttempts();
	const parsed = passkeyRegistrationSchema.safeParse(await readJsonBody(request, 64 * 1024).catch(() => null));
	if (!parsed.success) return NextResponse.json({ error: "Invalid passkey response" }, { status: 400 });
	return withPasskeys(async () => {
		const result = await finishPasskeyRegistration(
			env,
			request,
			auth.user,
			getSessionTokenFromRequestHeaders(request),
			parsed.data,
		);
		if (!result.ok) return passkeyFailure(result);
		await recordAuthActivity(env, {
			action: "auth.passkey_added",
			userId: auth.user.id,
			request,
			details: { passkeyName: result.value.name },
		});
		await noticeSignInChange(env, auth.user, { kind: "passkey_added", passkeyName: result.value.name });
		return noStoreJson({ ok: true, passkey: result.value });
	});
}
