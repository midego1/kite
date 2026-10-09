import { NextResponse } from "next/server";
import { evaluateSetupToken, SETUP_TOKEN_HEADER } from "./setup-token-utils";

/** null when the request may run first-run setup, otherwise the response to return. */
export function requireSetupToken(env: CloudflareEnv, request: Request): NextResponse | null {
	const decision = evaluateSetupToken({
		configured: env.SETUP_TOKEN,
		provided: request.headers.get(SETUP_TOKEN_HEADER),
		production: process.env.NODE_ENV === "production",
	});
	if (decision.ok) return null;
	return NextResponse.json({ error: decision.error, setupTokenRequired: true }, { status: decision.status });
}
