"use client";

import { authFetch } from "@/lib/auth/client";
import type { AuthMeResponse } from "./me-client-types";

export const AUTH_ME_QUERY_KEY = ["auth", "me"] as const;

/** Sign-in, sign-out and account switches reset the query cache, so this only bounds drift from other tabs. */
export const AUTH_ME_STALE_TIME_MS = 5 * 60_000;

export class AuthMeRequestError extends Error {
	constructor(readonly status: number) {
		super(`Session check failed with ${status}`);
	}
}

/** Resolves to null when there is no valid session; throws for any other failure. */
export async function fetchAuthMe(): Promise<AuthMeResponse | null> {
	const response = await authFetch("/api/auth/me", {
		redirectOnUnauthorized: false,
		cache: "no-store",
		signal: AbortSignal.timeout(5_000),
	});
	if (response.status === 401) return null;
	if (!response.ok) throw new AuthMeRequestError(response.status);
	return (await response.json()) as AuthMeResponse;
}
