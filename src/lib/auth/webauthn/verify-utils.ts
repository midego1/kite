import { CborError, decodeCbor, decodeCborItem, type CborValue } from "./cbor-utils";
import { assertUsableCoseKey, CoseKeyError, SUPPORTED_COSE_ALGORITHMS, verifyCoseSignature } from "./cose-utils";
import { base64UrlToBytes, bytesToBase64Url, timingSafeEqualStrings } from "./base64url-utils";
import type {
	AuthenticatorData,
	VerifiedAssertion,
	VerifiedRegistration,
	VerifyAssertionInput,
	VerifyRegistrationInput,
	WebAuthnErrorCode,
} from "./types";

/**
 * WebAuthn Level 3 relying-party checks (§7.1 registration, §7.2 authentication) for Kite's policy: user
 * verification is required, attestation is not used (the options ask for "none"), and only ES256, EdDSA and
 * RS256 keys are accepted. Pure: the caller supplies the expected challenge, origin and RP ID and stores the result.
 */

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_BE = 0x08;
const FLAG_BS = 0x10;
const FLAG_AT = 0x40;
const FLAG_ED = 0x80;
const MAX_CREDENTIAL_ID_BYTES = 1023;

export class WebAuthnError extends Error {
	readonly code: WebAuthnErrorCode;
	constructor(code: WebAuthnErrorCode, message: string) {
		super(message);
		this.name = "WebAuthnError";
		this.code = code;
	}
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
	return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	let difference = 0;
	for (let index = 0; index < a.length; index++) difference |= a[index] ^ b[index];
	return difference === 0;
}

function formatAaguid(bytes: Uint8Array): string {
	const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function parseAuthenticatorData(bytes: Uint8Array): AuthenticatorData {
	if (bytes.length < 37) throw new WebAuthnError("malformed", "Authenticator data is too short");
	const flags = bytes[32];
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const data: AuthenticatorData = {
		rpIdHash: bytes.slice(0, 32),
		flags,
		userPresent: (flags & FLAG_UP) !== 0,
		userVerified: (flags & FLAG_UV) !== 0,
		backupEligible: (flags & FLAG_BE) !== 0,
		backedUp: (flags & FLAG_BS) !== 0,
		signCount: view.getUint32(33),
		attestedCredential: null,
	};
	let offset = 37;
	try {
		if (flags & FLAG_AT) {
			if (bytes.length < offset + 18) throw new WebAuthnError("malformed", "Attested credential data is too short");
			const aaguid = bytes.slice(offset, offset + 16);
			const idLength = view.getUint16(offset + 16);
			offset += 18;
			if (idLength === 0 || idLength > MAX_CREDENTIAL_ID_BYTES || offset + idLength > bytes.length)
				throw new WebAuthnError("malformed", "Invalid credential id length");
			const credentialId = bytes.slice(offset, offset + idLength);
			offset += idLength;
			const { value, end } = decodeCborItem(bytes, offset);
			data.attestedCredential = {
				aaguid: formatAaguid(aaguid),
				credentialId,
				publicKey: bytes.slice(offset, end),
				publicKeyValue: value,
			};
			offset = end;
		}
		if (flags & FLAG_ED) offset = decodeCborItem(bytes, offset).end;
	} catch (error) {
		if (error instanceof CborError) throw new WebAuthnError("malformed", error.message);
		throw error;
	}
	if (offset !== bytes.length) throw new WebAuthnError("malformed", "Trailing bytes in authenticator data");
	return data;
}

type ClientData = { type: string; challenge: string; origin: string; crossOrigin?: unknown; topOrigin?: unknown };

function parseClientData(bytes: Uint8Array): ClientData {
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		throw new WebAuthnError("malformed", "Client data is not JSON");
	}
	const record = parsed as Partial<ClientData> | null;
	if (
		!record ||
		typeof record !== "object" ||
		typeof record.type !== "string" ||
		typeof record.challenge !== "string" ||
		typeof record.origin !== "string"
	)
		throw new WebAuthnError("malformed", "Client data is missing fields");
	return record as ClientData;
}

function checkClientData(
	clientData: ClientData,
	type: "webauthn.create" | "webauthn.get",
	input: { expectedChallenge: string; expectedOrigin: string },
): void {
	if (clientData.type !== type) throw new WebAuthnError("wrong_type", "Unexpected ceremony type");
	if (!timingSafeEqualStrings(clientData.challenge, input.expectedChallenge))
		throw new WebAuthnError("challenge_mismatch", "The challenge does not match");
	if (clientData.origin !== input.expectedOrigin) throw new WebAuthnError("origin_mismatch", "Unexpected origin");
	// Kite never embeds its sign-in in another site's frame.
	if (clientData.crossOrigin === true || clientData.topOrigin !== undefined)
		throw new WebAuthnError("origin_mismatch", "Cross-origin ceremonies are not accepted");
}

async function checkAuthenticatorFlags(data: AuthenticatorData, rpId: string): Promise<void> {
	if (!equalBytes(data.rpIdHash, await sha256(new TextEncoder().encode(rpId))))
		throw new WebAuthnError("rp_id_mismatch", "The credential belongs to another site");
	if (!data.userPresent) throw new WebAuthnError("user_not_present", "User presence is required");
	if (!data.userVerified) throw new WebAuthnError("user_not_verified", "User verification is required");
	if (data.backedUp && !data.backupEligible) throw new WebAuthnError("malformed", "Invalid backup flags");
}

/** §7.1: checks a `navigator.credentials.create()` response and returns what to store. */
export async function verifyRegistration(input: VerifyRegistrationInput): Promise<VerifiedRegistration> {
	checkClientData(parseClientData(input.clientDataJSON), "webauthn.create", input);

	let attestation: CborValue;
	try {
		attestation = decodeCbor(input.attestationObject);
	} catch {
		throw new WebAuthnError("malformed", "Attestation object is not CBOR");
	}
	if (!(attestation instanceof Map)) throw new WebAuthnError("malformed", "Attestation object is not a map");
	const fmt = attestation.get("fmt");
	const attStmt = attestation.get("attStmt");
	const authDataBytes = attestation.get("authData");
	if (typeof fmt !== "string" || !(attStmt instanceof Map) || !(authDataBytes instanceof Uint8Array))
		throw new WebAuthnError("malformed", "Attestation object is missing fields");
	// The options ask for no attestation, so the statement is never trusted. "none" must be empty; any other
	// format an authenticator sends anyway is treated the same as "none" (§5.4.7, "self"/"none" policy).
	if (fmt === "none" && attStmt.size !== 0) throw new WebAuthnError("malformed", "A 'none' attestation must be empty");

	const authData = parseAuthenticatorData(authDataBytes);
	await checkAuthenticatorFlags(authData, input.expectedRpId);
	const credential = authData.attestedCredential;
	if (!credential) throw new WebAuthnError("malformed", "No credential in the response");

	let algorithm: number;
	try {
		algorithm = (await assertUsableCoseKey(credential.publicKeyValue)).algorithm;
	} catch (error) {
		if (error instanceof CoseKeyError) throw new WebAuthnError("unsupported_algorithm", error.message);
		throw error;
	}
	const allowed = input.allowedAlgorithms ?? SUPPORTED_COSE_ALGORITHMS;
	if (!allowed.includes(algorithm)) throw new WebAuthnError("unsupported_algorithm", "Algorithm not allowed");

	return {
		credentialId: bytesToBase64Url(credential.credentialId),
		publicKey: bytesToBase64Url(credential.publicKey),
		algorithm,
		signCount: authData.signCount,
		aaguid: credential.aaguid,
		backupEligible: authData.backupEligible,
		backedUp: authData.backedUp,
		attestationFormat: fmt,
	};
}

/**
 * §7.2: checks a `navigator.credentials.get()` response against the stored key. Signature counters: 0 on both
 * sides is how synced passkeys report (no counter), anything else must grow, and a counter that did not is
 * refused as a possible cloned authenticator.
 */
export async function verifyAssertion(input: VerifyAssertionInput): Promise<VerifiedAssertion> {
	checkClientData(parseClientData(input.clientDataJSON), "webauthn.get", input);
	const authData = parseAuthenticatorData(input.authenticatorData);
	await checkAuthenticatorFlags(authData, input.expectedRpId);
	if (authData.attestedCredential) throw new WebAuthnError("malformed", "Unexpected credential data in an assertion");

	const signed = new Uint8Array(input.authenticatorData.length + 32);
	signed.set(input.authenticatorData, 0);
	signed.set(await sha256(input.clientDataJSON), input.authenticatorData.length);
	let valid: boolean;
	try {
		valid = await verifyCoseSignature(base64UrlToBytes(input.publicKey), input.signature, signed);
	} catch {
		valid = false;
	}
	if (!valid) throw new WebAuthnError("bad_signature", "The signature does not match");

	const stored = input.storedSignCount;
	if ((authData.signCount !== 0 || stored !== 0) && authData.signCount <= stored)
		throw new WebAuthnError("counter_regression", "The authenticator's counter went backwards");

	return { signCount: authData.signCount, backedUp: authData.backedUp };
}
