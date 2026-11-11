import { authFetch } from "@/lib/auth/client";
import { saveManagedAccount } from "../utils";
import type { PasswordSaveOptions } from "./types";

export async function saveAccountPassword({
	event,
	account,
	password,
	setPassword,
	setSaving,
	setMessage,
}: PasswordSaveOptions) {
	event.preventDefault();
	if (!account) return;
	setSaving(true);
	setMessage(null);
	try {
		await saveManagedAccount({ ...account, newPassword: password });
		setPassword("");
		setMessage("Password reset. This account has been signed out everywhere.");
	} catch (error) {
		setMessage(error instanceof Error ? error.message : "Unable to reset password");
	} finally {
		setSaving(false);
	}
}

/** Turns off the account's two-factor authentication and removes its passkeys and recovery codes; the admin confirms with their own password. */
export async function resetAccountSecondFactors(accountId: string, adminPassword: string): Promise<number> {
	const res = await authFetch(`/api/accounts/${encodeURIComponent(accountId)}/mfa`, {
		method: "DELETE",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ password: adminPassword }),
	});
	const data = (await res.json().catch(() => ({}))) as { passkeysRemoved?: number; error?: unknown };
	if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : "Unable to reset two-factor sign-in");
	return data.passkeysRemoved ?? 0;
}
