"use client";

import { authFetch, setClientSessionKey } from "@/lib/auth/client";

export type BrowserAccount = {
	userId: string;
	email: string;
	name: string;
	hasAvatar: boolean;
	active: boolean;
};

export async function fetchBrowserAccounts(): Promise<BrowserAccount[]> {
	try {
		const res = await authFetch("/api/auth/accounts", { redirectOnUnauthorized: false, cache: "no-store" });
		if (!res.ok) return [];
		return ((await res.json()) as { accounts: BrowserAccount[] }).accounts;
	} catch {
		return [];
	}
}

/** Returns an error message, or null once the switch succeeded. */
export async function switchBrowserAccount(userId: string): Promise<string | null> {
	const res = await authFetch("/api/auth/switch", {
		method: "POST",
		redirectOnUnauthorized: false,
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ userId }),
	});
	const data = (await res.json().catch(() => ({}))) as { userId?: string; error?: string };
	if (!res.ok || !data.userId) return data.error ?? "Could not switch account";
	setClientSessionKey(data.userId);
	return null;
}
