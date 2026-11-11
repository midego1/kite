import { base64UrlToBytes, bytesToBase64Url } from "@/lib/auth/webauthn/base64url-utils";
import type {
	AuthenticationCredentialJson,
	PasskeyCreationOptionsJson,
	PasskeyRequestOptionsJson,
	RegistrationCredentialJson,
} from "@/lib/auth/passkeys-types";

/**
 * Browser-side WebAuthn glue: the server's JSON options become the `ArrayBuffer`-based objects the WebAuthn API
 * takes, and the credentials it returns become JSON again. Written out by hand because
 * `PublicKeyCredential.parseCreationOptionsFromJSON` is not in every browser Kite supports.
 */

function buffer(value: string): ArrayBuffer {
	const bytes = base64UrlToBytes(value);
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function encode(value: ArrayBuffer | null): string {
	return value ? bytesToBase64Url(new Uint8Array(value)) : "";
}

export function passkeysSupported(): boolean {
	return typeof window !== "undefined" && typeof window.PublicKeyCredential === "function" && !!navigator.credentials;
}

/** Whether the browser can offer passkeys in the email field's autofill (WebAuthn conditional mediation). */
export async function conditionalMediationAvailable(): Promise<boolean> {
	if (!passkeysSupported()) return false;
	const check = (PublicKeyCredential as { isConditionalMediationAvailable?: () => Promise<boolean> })
		.isConditionalMediationAvailable;
	try {
		return typeof check === "function" ? await check.call(PublicKeyCredential) : false;
	} catch {
		return false;
	}
}

export function toCreationOptions(json: PasskeyCreationOptionsJson): PublicKeyCredentialCreationOptions {
	return {
		...json,
		challenge: buffer(json.challenge),
		user: { ...json.user, id: buffer(json.user.id) },
		excludeCredentials: json.excludeCredentials.map((credential) => ({
			type: credential.type,
			id: buffer(credential.id),
			...(credential.transports ? { transports: credential.transports as AuthenticatorTransport[] } : {}),
		})),
	};
}

export function toRequestOptions(json: PasskeyRequestOptionsJson): PublicKeyCredentialRequestOptions {
	return { ...json, challenge: buffer(json.challenge), allowCredentials: [] };
}

export function registrationToJson(credential: PublicKeyCredential): RegistrationCredentialJson {
	const response = credential.response as AuthenticatorAttestationResponse;
	const transports = typeof response.getTransports === "function" ? response.getTransports() : undefined;
	return {
		id: credential.id,
		rawId: encode(credential.rawId),
		type: "public-key",
		response: {
			clientDataJSON: encode(response.clientDataJSON),
			attestationObject: encode(response.attestationObject),
			...(transports ? { transports } : {}),
		},
	};
}

export function assertionToJson(credential: PublicKeyCredential): AuthenticationCredentialJson {
	const response = credential.response as AuthenticatorAssertionResponse;
	return {
		id: credential.id,
		rawId: encode(credential.rawId),
		type: "public-key",
		response: {
			clientDataJSON: encode(response.clientDataJSON),
			authenticatorData: encode(response.authenticatorData),
			signature: encode(response.signature),
			userHandle: response.userHandle ? encode(response.userHandle) : null,
		},
	};
}

/** The person closed the prompt, it timed out, or Kite aborted it to start another: not an error to show. */
export function isPasskeyCancel(error: unknown): boolean {
	return error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "AbortError");
}
