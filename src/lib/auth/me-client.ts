"use client";

import { markBootPhase } from "@/components/boot-trace-utils";
import { authFetch } from "@/lib/auth/client";
import type { AuthMeResponse } from "./me-client-types";
import { AUTH_ME_TIMEOUT_MS } from "./me-client-utils";

export const AUTH_ME_QUERY_KEY = ["auth", "me"] as const;

/** Sign-in, sign-out and account switches reset the query cache, so this only bounds drift from other tabs. */
export const AUTH_ME_STALE_TIME_MS = 5 * 60_000;

export class AuthMeRequestError extends Error {
	constructor(readonly status: number) {
		super(`Session check failed with ${status}`);
	}
}

/** Resolves to null when there is no valid session; throws for any other failure. */
export async function fetchAuthMe(timeoutMs = AUTH_ME_TIMEOUT_MS): Promise<AuthMeResponse | null> {
	const response = await authFetch("/api/auth/me", {
		redirectOnUnauthorized: false,
		cache: "no-store",
		signal: AbortSignal.timeout(timeoutMs),
	});
	if (response.status === 401) {
		markBootPhase("auth-answered");
		return null;
	}
	if (!response.ok) throw new AuthMeRequestError(response.status);
	const session = (await response.json()) as AuthMeResponse;
	// The boot trace's phase: from here React renders the app with the answer.
	markBootPhase("auth-answered");
	return session;
}
