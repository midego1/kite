import { authFetch } from "@/lib/auth/client";
import { isPasskeyCancel, registrationToJson, toCreationOptions } from "@/lib/auth/passkey-client-utils";
import type { PasskeyCreationOptionsJson, PasskeySummary } from "@/lib/auth/passkeys-types";
import type { PasskeyList, PasskeyReauth } from "./passkey-settings-types";

function errorMessage(data: { error?: unknown }, fallback: string): string {
	return typeof data.error === "string" ? data.error : fallback;
}

export async function loadPasskeys(): Promise<PasskeyList> {
	const res = await authFetch("/api/settings/passkeys");
	const data = (await res.json().catch(() => ({}))) as Partial<PasskeyList> & { error?: unknown };
	if (!res.ok) throw new Error(errorMessage(data, "Failed to load passkeys"));
	return { available: data.available !== false, passkeys: data.passkeys ?? [] };
}

/**
 * Adds a passkey: re-checks the password or code, asks the browser to create the credential, then hands the
 * public key to Kite. Resolves null when the person closed the browser's prompt.
 */
export async function addPasskey(reauth: PasskeyReauth, name: string): Promise<PasskeySummary | null> {
	const optionsRes = await authFetch("/api/settings/passkeys/options", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(reauth),
	});
	const optionsData = (await optionsRes.json().catch(() => ({}))) as {
		ceremonyId?: string;
		options?: PasskeyCreationOptionsJson;
		error?: unknown;
	};
	if (!optionsRes.ok || !optionsData.ceremonyId || !optionsData.options)
		throw new Error(errorMessage(optionsData, "Could not start adding a passkey"));

	let credential: Credential | null;
	try {
		credential = await navigator.credentials.create({ publicKey: toCreationOptions(optionsData.options) });
	} catch (error) {
		if (isPasskeyCancel(error)) return null;
		if (error instanceof DOMException && error.name === "InvalidStateError")
			throw new Error("This device already has a passkey for your account.");
		throw new Error("Your browser could not create a passkey.");
	}
	if (!credential) return null;

	const res = await authFetch("/api/settings/passkeys", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			ceremonyId: optionsData.ceremonyId,
			name: name.trim() || null,
			credential: registrationToJson(credential as PublicKeyCredential),
		}),
	});
	const data = (await res.json().catch(() => ({}))) as { passkey?: PasskeySummary; error?: unknown };
	if (!res.ok || !data.passkey) throw new Error(errorMessage(data, "Could not save the passkey"));
	return data.passkey;
}

export async function removePasskey(id: string, reauth: PasskeyReauth): Promise<void> {
	const res = await authFetch(`/api/settings/passkeys/${encodeURIComponent(id)}`, {
		method: "DELETE",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(reauth),
	});
	const data = (await res.json().catch(() => ({}))) as { error?: unknown };
	if (!res.ok) throw new Error(errorMessage(data, "Could not remove the passkey"));
}

/** Whether the account has an authenticator app, which offers a code instead of the password in the dialogs. */
export async function loadTotpEnabled(): Promise<boolean> {
	const res = await authFetch("/api/settings/mfa");
	if (!res.ok) return false;
	const data = (await res.json().catch(() => ({}))) as { enabled?: boolean };
	return data.enabled === true;
}
