import { bytesToBase64Url } from "@/lib/auth/webauthn/base64url-utils";

/**
 * The WebAuthn relying party: the origin passkeys are bound to and its host name as the RP ID. `APP_URL` wins when
 * it is set and valid, so a passkey made at the public address keeps working behind a proxy; otherwise the
 * request's own origin is used (local development, installs without APP_URL).
 */
export function relyingParty(appUrl: string | undefined, requestUrl: string): { id: string; origin: string } {
	const configured = appUrl?.trim();
	if (configured) {
		try {
			const url = new URL(configured);
			if (url.protocol === "https:" || url.protocol === "http:") return { id: url.hostname, origin: url.origin };
		} catch {
			// An unusable APP_URL falls back to the request's own origin, like `appOrigin` in Drive.
		}
	}
	const url = new URL(requestUrl);
	return { id: url.hostname, origin: url.origin };
}

/**
 * What an admin should know about the relying party: without a valid APP_URL, passkeys are bound to whatever address
 * each request arrives at, which behind a proxy that terminates TLS is not the address the browser shows, so passkeys
 * fail. Null when APP_URL is a usable address.
 */
export function appUrlPasskeyWarning(appUrl: string | undefined): string | null {
	const configured = appUrl?.trim();
	if (!configured)
		return "APP_URL is not set, so passkeys use the address each request arrives at. Set APP_URL to Kite's public address, or passkeys may fail behind a proxy and stop working if the address changes.";
	try {
		const url = new URL(configured);
		if (url.protocol === "https:" || url.protocol === "http:") return null;
	} catch {
		// Falls through to the warning below.
	}
	return `APP_URL (${configured}) is not a valid http or https address, so passkeys use the address each request arrives at. Fix APP_URL before people add passkeys.`;
}

/** Five minutes for the browser prompt; the stored challenge lives as long, plus a little for the round trip. */
export const PASSKEY_CEREMONY_TIMEOUT_MS = 5 * 60 * 1000;
export const PASSKEY_CHALLENGE_TTL_MS = PASSKEY_CEREMONY_TIMEOUT_MS + 30 * 1000;

/** The httpOnly cookie that binds a sign-in ceremony to the browser that started it. */
export const PASSKEY_CEREMONY_COOKIE = "kite_passkey_ceremony";

export const MAX_PASSKEYS_PER_USER = 20;

/** A label for a new passkey when the user did not give one, from the browser's platform. */
export function defaultPasskeyName(userAgent: string | null): string {
	const agent = userAgent ?? "";
	if (/iphone|ipad/i.test(agent)) return "iPhone or iPad passkey";
	if (/android/i.test(agent)) return "Android passkey";
	if (/mac os|macintosh/i.test(agent)) return "Mac passkey";
	if (/windows/i.test(agent)) return "Windows passkey";
	if (/linux|cros/i.test(agent)) return "Linux passkey";
	return "Passkey";
}

/** Trims, collapses whitespace and caps a passkey name; empty becomes null so the caller can pick a default. */
export function normalizePasskeyName(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const name = value.replace(/\s+/g, " ").trim().slice(0, 64);
	return name || null;
}

/** What the person sees when a ceremony fails, by `WebAuthnError` code; the code itself is only logged. */
export function passkeyErrorMessage(code: string): string {
	switch (code) {
		case "challenge_mismatch":
			return "This passkey request has expired. Try again.";
		case "origin_mismatch":
		case "rp_id_mismatch":
			return "This passkey was made for another address.";
		case "user_not_verified":
		case "user_not_present":
			return "Your device did not confirm it was you (PIN, fingerprint or face). Try again.";
		case "unsupported_algorithm":
			return "This passkey uses a kind of key Kite does not support.";
		case "counter_regression":
			return "This passkey was refused because it may have been copied. Remove it and add it again.";
		default:
			return "This passkey could not be verified.";
	}
}

const TRANSPORTS = new Set(["usb", "nfc", "ble", "smart-card", "hybrid", "internal"]);

/** Keeps only the transport names WebAuthn defines, so the stored hint list is never arbitrary client text. */
export function sanitizeTransports(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return [...new Set(value.filter((item): item is string => typeof item === "string" && TRANSPORTS.has(item)))];
}

/** The WebAuthn user handle: the user id's bytes, opaque and never an email address (§14.6.1). */
export function userHandleFor(userId: string): string {
	return bytesToBase64Url(new TextEncoder().encode(userId));
}

export type SignInChange =
	| { kind: "passkey_added"; passkeyName: string }
	| { kind: "passkey_removed"; passkeyName: string }
	| { kind: "second_factors_reset"; passkeysRemoved: number };

/** The notice mailed to the account holder when a way to sign in changes, so a change they did not make stands out. */
export function signInChangeMail(change: SignInChange, appName: string): { subject: string; text: string } {
	const unexpected = `If this was not you, change your ${appName} password now and remove any passkey you do not recognise in Settings → Security.`;
	switch (change.kind) {
		case "passkey_added":
			return {
				subject: `A passkey was added to your ${appName} account`,
				text: `The passkey "${change.passkeyName}" can now sign in to your ${appName} account.\n\n${unexpected}`,
			};
		case "passkey_removed":
			return {
				subject: `A passkey was removed from your ${appName} account`,
				text: `The passkey "${change.passkeyName}" no longer signs in to your ${appName} account.\n\n${unexpected}`,
			};
		case "second_factors_reset": {
			const count = change.passkeysRemoved;
			const passkeys = count ? `, ${count} passkey${count === 1 ? " was" : "s were"} removed` : "";
			return {
				subject: `Two-factor sign-in was reset on your ${appName} account`,
				text: `An administrator reset two-factor sign-in on your ${appName} account: the authenticator app was turned off, the recovery codes were deleted${passkeys}, and you were signed out everywhere. Sign in with your password to set it up again.\n\nIf you did not ask for this, contact your administrator.`,
			};
		}
	}
}
