/** A passkey as Settings → Security lists it; never the key itself. */
export type PasskeySummary = {
	id: string;
	name: string;
	createdAt: string;
	lastUsedAt: string | null;
	/** Synced to a cloud account (iCloud Keychain, Google Password Manager, a password manager). */
	backedUp: boolean;
};

/** `navigator.credentials.create()`'s result with every buffer as base64url. */
export type RegistrationCredentialJson = {
	id: string;
	rawId: string;
	type: "public-key";
	response: { clientDataJSON: string; attestationObject: string; transports?: string[] };
};

/** `navigator.credentials.get()`'s result with every buffer as base64url. */
export type AuthenticationCredentialJson = {
	id: string;
	rawId: string;
	type: "public-key";
	response: { clientDataJSON: string; authenticatorData: string; signature: string; userHandle?: string | null };
};

/** `PublicKeyCredentialCreationOptions` with buffers as base64url, for the browser to decode. */
export type PasskeyCreationOptionsJson = {
	rp: { id: string; name: string };
	user: { id: string; name: string; displayName: string };
	challenge: string;
	pubKeyCredParams: { type: "public-key"; alg: number }[];
	timeout: number;
	attestation: "none";
	authenticatorSelection: { residentKey: "required"; requireResidentKey: true; userVerification: "required" };
	excludeCredentials: { type: "public-key"; id: string; transports?: string[] }[];
	extensions: { credProps: true };
};

/** `PublicKeyCredentialRequestOptions` with buffers as base64url. */
export type PasskeyRequestOptionsJson = {
	challenge: string;
	rpId: string;
	timeout: number;
	userVerification: "required";
	allowCredentials: [];
};

export type PasskeyResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string; code?: string };
