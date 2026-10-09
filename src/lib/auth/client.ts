"use client";

import { getUserTimeZone } from "@/lib/time/utils";
import { clearUserTimeZonePreference } from "@/lib/time/client";
import { changesCurrentAccount } from "./client-utils";
import type { AuthFetchOptions, AuthSessionChangedDetail, AuthSessionResponse } from "./client-types";

// The session token lives only in the httpOnly ep_session cookie. The browser keeps
// the active user id (not a secret) so tabs and caches can tell when the account changed.
const SESSION_STORAGE_KEY = "kite-session-user";
const LEGACY_TOKEN_STORAGE_KEY = "kite-session-token";
const LEGACY_SESSION_KEY = "legacy-session";
export const AUTH_SESSION_CHANGED_EVENT = "kite:auth-session-changed";
/** The cached `/api/auth/me` answer may be out of date after a successful account-related write. */
export const AUTH_ME_STALE_EVENT = "kite:auth-me-stale";

function dispatchAuthSessionChanged(authenticated: boolean): void {
	if (typeof window === "undefined") return;
	window.dispatchEvent(
		new CustomEvent<AuthSessionChangedDetail>(AUTH_SESSION_CHANGED_EVENT, {
			detail: { authenticated },
		}),
	);
}

/** A non-secret key identifying the active browser session, or null when signed out. */
export function getClientSessionKey(): string | null {
	if (typeof window === "undefined") return null;
	if (localStorage.getItem(LEGACY_TOKEN_STORAGE_KEY) !== null) {
		localStorage.removeItem(LEGACY_TOKEN_STORAGE_KEY);
		if (localStorage.getItem(SESSION_STORAGE_KEY) === null)
			localStorage.setItem(SESSION_STORAGE_KEY, LEGACY_SESSION_KEY);
	}
	return localStorage.getItem(SESSION_STORAGE_KEY);
}

export function setClientSessionKey(userId: string): void {
	const previous = getClientSessionKey();
	localStorage.setItem(SESSION_STORAGE_KEY, userId);
	if (previous !== userId) clearUserTimeZonePreference();
	if (previous !== userId) dispatchAuthSessionChanged(true);
}

export function clearClientSessionKey(): void {
	localStorage.removeItem(SESSION_STORAGE_KEY);
	localStorage.removeItem(LEGACY_TOKEN_STORAGE_KEY);
	clearUserTimeZonePreference();
	dispatchAuthSessionChanged(false);
}

export function getAuthHeaders(headers?: HeadersInit): Headers {
	const nextHeaders = new Headers(headers);
	if (typeof window !== "undefined" && !nextHeaders.has("X-Time-Zone")) {
		nextHeaders.set("X-Time-Zone", getUserTimeZone());
	}
	return nextHeaders;
}

export async function authFetch(input: RequestInfo | URL, init: AuthFetchOptions = {}): Promise<Response> {
	const { redirectOnUnauthorized = true, headers, ...requestInit } = init;
	const response = await fetch(input, {
		...requestInit,
		headers: getAuthHeaders(headers),
	});

	if (response.status === 401 && redirectOnUnauthorized && typeof window !== "undefined") {
		clearClientSessionKey();
		window.location.assign("/login");
	}
	if (response.ok && typeof window !== "undefined" && changesCurrentAccount(input, requestInit.method)) {
		window.dispatchEvent(new Event(AUTH_ME_STALE_EVENT));
	}

	return response;
}

export async function persistAuthSession(response: Response): Promise<AuthSessionResponse> {
	const data = (await response.json()) as AuthSessionResponse;
	if (response.ok && data.userId) {
		const previous = getClientSessionKey();
		setClientSessionKey(data.userId);
		// A session revoked on the server (restore, password reset, expiry) can leave the
		// same user id behind; signing in again must still drop state cached while signed out.
		if (previous === data.userId) dispatchAuthSessionChanged(true);
	}
	return data;
}
