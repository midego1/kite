import { persistAuthSession } from "@/lib/auth/client";
import { assertionToJson, isPasskeyCancel, toRequestOptions } from "@/lib/auth/passkey-client-utils";
import type { PasskeyRequestOptionsJson } from "@/lib/auth/passkeys-types";
import type { LoginResult } from "./types";

export async function submitLogin(form: FormData): Promise<{ ok: boolean; data: LoginResult }> {
	const res = await fetch("/api/auth/login", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		signal: AbortSignal.timeout(20_000),
		body: JSON.stringify({
			email: form.get("email"),
			password: form.get("password"),
			turnstileToken: form.get("turnstileToken"),
		}),
	});

	return {
		ok: res.ok,
		data: (await persistAuthSession(res)) as LoginResult,
	};
}

/** Second step: the challenge from the password step plus a TOTP or recovery code. */
export async function submitMfaCode(challengeToken: string, code: string): Promise<{ ok: boolean; data: LoginResult }> {
	const res = await fetch("/api/auth/mfa/verify", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		signal: AbortSignal.timeout(20_000),
		body: JSON.stringify({ challengeToken, code }),
	});
	return { ok: res.ok, data: (await persistAuthSession(res)) as LoginResult };
}

/** The server could not start a passkey sign-in (rate limit, database update pending); autofill stays quiet. */
export class PasskeySignInUnavailableError extends Error {}

/**
 * A passkey sign-in: fetch a challenge, let the browser ask for a passkey (as autofill when `conditional`, as a
 * dialog otherwise), then trade the signed assertion for a session. Resolves null when the person cancelled or the
 * prompt was aborted; throws with a message to show for anything else.
 */
export async function signInWithPasskey(input: {
	conditional: boolean;
	signal: AbortSignal;
}): Promise<{ ok: boolean; data: LoginResult } | null> {
	const optionsResponse = await fetch("/api/auth/passkey/options", {
		method: "POST",
		signal: AbortSignal.any([input.signal, AbortSignal.timeout(20_000)]),
	});
	const optionsData = (await optionsResponse.json().catch(() => ({}))) as {
		options?: PasskeyRequestOptionsJson;
		error?: string;
	};
	if (!optionsResponse.ok || !optionsData.options)
		throw new PasskeySignInUnavailableError(optionsData.error ?? "Passkey sign-in is not available right now.");
	let credential: Credential | null;
	try {
		credential = await navigator.credentials.get({
			publicKey: toRequestOptions(optionsData.options),
			signal: input.signal,
			...(input.conditional ? { mediation: "conditional" as CredentialMediationRequirement } : {}),
		});
	} catch (error) {
		// Autofill is offered on the side: whatever the browser says about it, the password form stays as it was.
		if (input.conditional || isPasskeyCancel(error)) return null;
		throw new Error("Your browser could not use a passkey. Try again or sign in with your password.");
	}
	if (!credential) return null;
	const res = await fetch("/api/auth/passkey/verify", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		signal: AbortSignal.timeout(20_000),
		body: JSON.stringify({ credential: assertionToJson(credential as PublicKeyCredential) }),
	});
	return { ok: res.ok, data: (await persistAuthSession(res)) as LoginResult };
}
