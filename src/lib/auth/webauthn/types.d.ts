import type { CborValue } from "./cbor-utils";

export type WebAuthnErrorCode =
	| "malformed"
	| "wrong_type"
	| "challenge_mismatch"
	| "origin_mismatch"
	| "rp_id_mismatch"
	| "user_not_present"
	| "user_not_verified"
	| "unsupported_algorithm"
	| "bad_signature"
	| "counter_regression";

export type AuthenticatorData = {
	rpIdHash: Uint8Array;
	flags: number;
	userPresent: boolean;
	userVerified: boolean;
	backupEligible: boolean;
	backedUp: boolean;
	signCount: number;
	attestedCredential: {
		aaguid: string;
		credentialId: Uint8Array;
		/** The COSE key exactly as the authenticator encoded it. */
		publicKey: Uint8Array;
		publicKeyValue: CborValue;
	} | null;
};

type Expected = {
	/** Base64url, as issued in the options. */
	expectedChallenge: string;
	/** Exact origin, for example `https://mail.example.com`. */
	expectedOrigin: string;
	expectedRpId: string;
};

export type VerifyRegistrationInput = Expected & {
	clientDataJSON: Uint8Array;
	attestationObject: Uint8Array;
	allowedAlgorithms?: readonly number[];
};

export type VerifiedRegistration = {
	/** Base64url credential id. */
	credentialId: string;
	/** Base64url COSE public key. */
	publicKey: string;
	algorithm: number;
	signCount: number;
	aaguid: string;
	backupEligible: boolean;
	backedUp: boolean;
	attestationFormat: string;
};

export type VerifyAssertionInput = Expected & {
	clientDataJSON: Uint8Array;
	authenticatorData: Uint8Array;
	signature: Uint8Array;
	/** Base64url COSE public key from registration. */
	publicKey: string;
	storedSignCount: number;
};

export type VerifiedAssertion = { signCount: number; backedUp: boolean };
