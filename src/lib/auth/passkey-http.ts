import { NextResponse } from "next/server";
import { requireSessionUser } from "@/lib/api/auth";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { allowLoginAttempt } from "@/lib/auth/rate-limit";
import { verifyReauthentication } from "@/lib/auth/reauth";
import { readJsonBody } from "@/lib/http/request";
import { passkeyReauthSchema } from "@/lib/validators";
import { PasskeysUnavailableError } from "@/lib/auth/passkeys";
import type { PasskeyResult } from "@/lib/auth/passkeys-types";

type SignedInUser = NonNullable<Awaited<ReturnType<typeof requireSessionUser>>["user"]>;

const NO_STORE = { "Cache-Control": "no-store" };

/** Runs a passkey route; before migration 0112 it answers 503 `MIGRATION_PENDING` instead of failing. */
export async function withPasskeys(run: () => Promise<Response>): Promise<Response> {
	try {
		return await run();
	} catch (error) {
		if (!(error instanceof PasskeysUnavailableError)) throw error;
		return NextResponse.json({ error: error.message, code: "MIGRATION_PENDING" }, { status: 503, headers: NO_STORE });
	}
}

export function passkeyFailure(result: Extract<PasskeyResult<unknown>, { ok: false }>): NextResponse {
	return NextResponse.json({ error: result.error, code: result.code }, { status: result.status, headers: NO_STORE });
}

export function tooManyAttempts(): NextResponse {
	return NextResponse.json(
		{ error: "Too many attempts. Try again shortly." },
		{ status: 429, headers: { "Retry-After": "60" } },
	);
}

export function noStoreJson(body: unknown, init?: { status?: number }): NextResponse {
	return NextResponse.json(body, { status: init?.status ?? 200, headers: NO_STORE });
}

/**
 * The guard in front of adding or removing a passkey: a session, a same-origin request, the login rate limit, then
 * the password or an authenticator code in the body. Returns the user, or the response to send instead.
 */
export async function requirePasskeyReauthentication(
	env: CloudflareEnv,
	request: Request,
): Promise<{ user: SignedInUser; error: null } | { user: null; error: Response }> {
	const auth = await requireSessionUser(env, request);
	if (auth.error) return { user: null, error: auth.error };
	if (!hasValidSessionMutationOrigin(request))
		return { user: null, error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
	if (!(await allowLoginAttempt(env, request))) return { user: null, error: tooManyAttempts() };
	const parsed = passkeyReauthSchema.safeParse(await readJsonBody(request, 16 * 1024).catch(() => null));
	if (!parsed.success)
		return { user: null, error: NextResponse.json({ error: "Enter your password" }, { status: 400 }) };
	if (!(await verifyReauthentication(auth.user, parsed.data))) {
		const error = parsed.data.password !== undefined ? "Password is incorrect" : "That code did not match";
		return { user: null, error: NextResponse.json({ error }, { status: 400 }) };
	}
	return { user: auth.user, error: null };
}
