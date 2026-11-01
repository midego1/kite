"use client";

import { BOOT_STALLED_EVENT, markBootPhase } from "@/components/boot-trace-utils";
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

/**
 * The request's signal: its timeout, or the boot watchdog's word that the start stalled (BOOT_STALLED_EVENT), which
 * aborts it as a timeout so the query's own retry sends a fresh one. That covers a request that outlives its timeout
 * (a timer that never fires, a connection the browser keeps waiting on). The timeout stays linked for the request's
 * whole life, as a plain timeout signal would, so it still cancels a body nobody reads (a 401); `release` only stops
 * listening for the stall once the answer is in.
 */
function sessionCheckSignal(timeoutMs: number): { signal: AbortSignal; release: () => void } {
	const controller = new AbortController();
	const timeout = AbortSignal.timeout(timeoutMs);
	const onStalled = () => controller.abort(new DOMException("The start stalled", "TimeoutError"));
	const release = () => {
		if (typeof window !== "undefined") window.removeEventListener(BOOT_STALLED_EVENT, onStalled);
	};
	timeout.addEventListener("abort", () => controller.abort(timeout.reason), { once: true });
	if (typeof window !== "undefined") window.addEventListener(BOOT_STALLED_EVENT, onStalled);
	return { signal: controller.signal, release };
}

/** Resolves to null when there is no valid session; throws for any other failure. */
export async function fetchAuthMe(timeoutMs = AUTH_ME_TIMEOUT_MS): Promise<AuthMeResponse | null> {
	const { signal, release } = sessionCheckSignal(timeoutMs);
	// Keep the timeout and the stall signal listening until the body is read: authFetch resolves with the headers,
	// and a body that stalls after them must still abort and retry.
	try {
		const response = await authFetch("/api/auth/me", { redirectOnUnauthorized: false, cache: "no-store", signal });
		if (response.status === 401) {
			markBootPhase("auth-answered");
			return null;
		}
		if (!response.ok) throw new AuthMeRequestError(response.status);
		const session = (await response.json()) as AuthMeResponse;
		// The boot trace's phase: from here React renders the app with the answer.
		markBootPhase("auth-answered");
		return session;
	} finally {
		release();
	}
}
