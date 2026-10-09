import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getEnv } from "@/lib/cloudflare";
import {
	ACCOUNTS_COOKIE,
	cookieOptions,
	isSameOrigin,
	parseAccountTokens,
	resolveAccounts,
	serializeAccountTokens,
} from "@/lib/auth/accounts";
import { SESSION_COOKIE } from "@/lib/auth/session";

/**
 * Make another signed-in account the active one. The client names a user id;
 * the token comes from the httpOnly accounts cookie and is re-validated here.
 * Only the user id is returned; the token never leaves the httpOnly cookies.
 */
export async function POST(request: Request) {
	if (!isSameOrigin(request)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
	const env = getEnv();
	const body = (await request.json().catch(() => null)) as { userId?: unknown } | null;
	const userId = typeof body?.userId === "string" ? body.userId : "";
	const jar = await cookies();
	const accounts = await resolveAccounts(env, parseAccountTokens(jar.get(ACCOUNTS_COOKIE)?.value));
	const target = accounts.find((account) => account.userId === userId);
	if (!target) return NextResponse.json({ error: "Sign in again to use this account" }, { status: 401 });

	const response = NextResponse.json({ ok: true, userId: target.userId, redirect: "/inbox" });
	response.headers.set("Cache-Control", "no-store");
	response.cookies.set(SESSION_COOKIE, target.token, cookieOptions());
	// Prune dead entries while we are here.
	response.cookies.set(
		ACCOUNTS_COOKIE,
		serializeAccountTokens(accounts.map((account) => account.token)),
		cookieOptions(),
	);
	return response;
}
