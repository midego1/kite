import { authFetch, clearClientSessionKey, setClientSessionKey } from "@/lib/auth/client";

/** Returns true when another signed-in account on this browser took over. */
export async function logoutClientSession(): Promise<boolean> {
	let nextUserId: string | undefined;
	try {
		const response = await authFetch("/api/auth/logout", {
			method: "POST",
			redirectOnUnauthorized: false,
		});
		nextUserId = ((await response.json().catch(() => null)) as { userId?: string } | null)?.userId;
	} catch {
		// Local logout must complete even when the server request is unavailable.
	} finally {
		clearClientSessionKey();
	}
	if (!nextUserId) return false;
	setClientSessionKey(nextUserId);
	return true;
}
