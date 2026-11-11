import { and, asc, eq, lt } from "drizzle-orm";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { passkeys } from "@/db/schema/passkeys";
import { newId } from "@/lib/ids";
import { getBranding } from "@/lib/branding/service";
import { isNoSuchTableError } from "@/lib/modules/state-utils";
import { findUser } from "@/lib/auth/user-lookup";
import { consumePasskeyChallenge, createPasskeyChallenge } from "@/lib/auth/passkey-challenges";
import {
	defaultPasskeyName,
	MAX_PASSKEYS_PER_USER,
	normalizePasskeyName,
	PASSKEY_CEREMONY_TIMEOUT_MS,
	passkeyErrorMessage,
	relyingParty,
	sanitizeTransports,
	userHandleFor,
} from "@/lib/auth/passkey-utils";
import { SUPPORTED_COSE_ALGORITHMS } from "@/lib/auth/webauthn/cose-utils";
import { base64UrlToBytes } from "@/lib/auth/webauthn/base64url-utils";
import { verifyAssertion, verifyRegistration, WebAuthnError } from "@/lib/auth/webauthn/verify-utils";
import type {
	AuthenticationCredentialJson,
	PasskeyCreationOptionsJson,
	PasskeyRequestOptionsJson,
	PasskeyResult,
	PasskeySummary,
	RegistrationCredentialJson,
} from "@/lib/auth/passkeys-types";

/** Thrown while migration 0112 is not applied; routes answer 503 and password sign-in is unaffected. */
export class PasskeysUnavailableError extends Error {
	constructor() {
		super("Passkeys are available after the next database update");
		this.name = "PasskeysUnavailableError";
	}
}

async function guard<T>(run: () => Promise<T>): Promise<T> {
	try {
		return await run();
	} catch (error) {
		if (isNoSuchTableError(error)) throw new PasskeysUnavailableError();
		throw error;
	}
}

function summary(row: typeof passkeys.$inferSelect): PasskeySummary {
	return {
		id: row.id,
		name: row.name,
		createdAt: row.createdAt.toISOString(),
		lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
		backedUp: row.backedUp,
	};
}

function bytes(value: string): Uint8Array {
	return base64UrlToBytes(value);
}

export async function listPasskeys(env: CloudflareEnv, userId: string): Promise<PasskeySummary[]> {
	return guard(async () => {
		const rows = await getDb(env)
			.select()
			.from(passkeys)
			.where(eq(passkeys.userId, userId))
			.orderBy(asc(passkeys.createdAt));
		return rows.map(summary);
	});
}

/** Options for `navigator.credentials.create()`, bound to the user and the session asking. */
export async function beginPasskeyRegistration(
	env: CloudflareEnv,
	request: Request,
	user: { id: string; email: string; name: string },
	sessionToken: string | undefined,
): Promise<PasskeyResult<{ ceremonyId: string; options: PasskeyCreationOptionsJson }>> {
	return guard(async () => {
		const existing = await getDb(env)
			.select({ credentialId: passkeys.credentialId, transports: passkeys.transports })
			.from(passkeys)
			.where(eq(passkeys.userId, user.id));
		if (existing.length >= MAX_PASSKEYS_PER_USER) return { ok: false, status: 400, error: capMessage(), code: "limit" };
		const rp = relyingParty(env.APP_URL, request.url);
		const { appName } = await getBranding(env);
		const { token, challenge } = await createPasskeyChallenge(env, {
			purpose: "register",
			userId: user.id,
			sessionToken,
		});
		return {
			ok: true,
			value: {
				ceremonyId: token,
				options: {
					rp: { id: rp.id, name: appName },
					user: { id: userHandleFor(user.id), name: user.email, displayName: user.name || user.email },
					challenge,
					pubKeyCredParams: SUPPORTED_COSE_ALGORITHMS.map((alg) => ({ type: "public-key" as const, alg })),
					timeout: PASSKEY_CEREMONY_TIMEOUT_MS,
					attestation: "none",
					authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
					excludeCredentials: existing.map((row) => ({
						type: "public-key" as const,
						id: row.credentialId,
						...(row.transports ? { transports: sanitizeTransports(JSON.parse(row.transports)) } : {}),
					})),
					extensions: { credProps: true },
				},
			},
		};
	});
}

/** Verifies the new credential against the ceremony's challenge and stores its public key. */
export async function finishPasskeyRegistration(
	env: CloudflareEnv,
	request: Request,
	user: { id: string },
	sessionToken: string | undefined,
	input: { ceremonyId: string; name?: string | null; credential: RegistrationCredentialJson },
): Promise<PasskeyResult<PasskeySummary>> {
	return guard(async () => {
		const challenge = await consumePasskeyChallenge(env, input.ceremonyId, {
			purpose: "register",
			userId: user.id,
			sessionToken,
		});
		if (!challenge)
			return { ok: false, status: 400, error: passkeyErrorMessage("challenge_mismatch"), code: "expired" };
		if (input.credential.id !== input.credential.rawId)
			return { ok: false, status: 400, error: passkeyErrorMessage("malformed"), code: "malformed" };
		const rp = relyingParty(env.APP_URL, request.url);
		let verified;
		try {
			verified = await verifyRegistration({
				clientDataJSON: bytes(input.credential.response.clientDataJSON),
				attestationObject: bytes(input.credential.response.attestationObject),
				expectedChallenge: challenge,
				expectedOrigin: rp.origin,
				expectedRpId: rp.id,
			});
		} catch (error) {
			return failure(error, "registration");
		}
		if (verified.credentialId !== input.credential.id)
			return { ok: false, status: 400, error: passkeyErrorMessage("malformed"), code: "malformed" };

		const db = getDb(env);
		const [taken] = await db
			.select({ id: passkeys.id })
			.from(passkeys)
			.where(eq(passkeys.credentialId, verified.credentialId))
			.limit(1);
		if (taken) return { ok: false, status: 409, error: "This passkey is already registered.", code: "duplicate" };
		const transports = sanitizeTransports(input.credential.response.transports);
		const id = newId("pk");
		const inserted = await insertWithinCap(env, {
			id,
			userId: user.id,
			credentialId: verified.credentialId,
			publicKey: verified.publicKey,
			algorithm: verified.algorithm,
			signCount: verified.signCount,
			transports: transports.length ? JSON.stringify(transports) : null,
			aaguid: verified.aaguid,
			backupEligible: verified.backupEligible,
			backedUp: verified.backedUp,
			name: normalizePasskeyName(input.name) ?? defaultPasskeyName(request.headers.get("user-agent")),
		});
		if (inserted === "duplicate")
			return { ok: false, status: 409, error: "This passkey is already registered.", code: "duplicate" };
		if (inserted === "cap") return { ok: false, status: 400, error: capMessage(), code: "limit" };
		const [row] = await db.select().from(passkeys).where(eq(passkeys.id, id)).limit(1);
		return { ok: true, value: summary(row) };
	});
}

/** Options for a sign-in with any passkey on this site (discoverable credentials, so no list of ids). */
export async function beginPasskeySignIn(
	env: CloudflareEnv,
	request: Request,
): Promise<{ token: string; options: PasskeyRequestOptionsJson }> {
	return guard(async () => {
		const rp = relyingParty(env.APP_URL, request.url);
		const { token, challenge } = await createPasskeyChallenge(env, { purpose: "authenticate" });
		return {
			token,
			options: {
				challenge,
				rpId: rp.id,
				timeout: PASSKEY_CEREMONY_TIMEOUT_MS,
				userVerification: "required",
				allowCredentials: [],
			},
		};
	});
}

/**
 * Verifies a sign-in assertion. User verification is required, so a passkey is both factors at once: the caller
 * creates a session without asking for a TOTP code.
 */
export async function finishPasskeySignIn(
	env: CloudflareEnv,
	request: Request,
	ceremonyToken: string,
	credential: AuthenticationCredentialJson,
): Promise<PasskeyResult<{ userId: string; passkeyId: string; passkeyName: string }>> {
	return guard(async () => {
		const challenge = await consumePasskeyChallenge(env, ceremonyToken, { purpose: "authenticate" });
		if (!challenge)
			return { ok: false, status: 401, error: passkeyErrorMessage("challenge_mismatch"), code: "expired" };
		if (credential.id !== credential.rawId)
			return { ok: false, status: 400, error: passkeyErrorMessage("malformed"), code: "malformed" };
		const db = getDb(env);
		const [stored] = await db.select().from(passkeys).where(eq(passkeys.credentialId, credential.id)).limit(1);
		if (!stored)
			return {
				ok: false,
				status: 401,
				error: "This passkey is not registered here. It may have been removed; sign in with your password.",
				code: "unknown_credential",
			};
		// A discoverable credential names its account; it must be the one the key was registered to (§7.2 step 6).
		if (!credential.response.userHandle || credential.response.userHandle !== userHandleFor(stored.userId))
			return { ok: false, status: 401, error: passkeyErrorMessage("malformed"), code: "user_handle_mismatch" };

		const rp = relyingParty(env.APP_URL, request.url);
		let verified;
		try {
			verified = await verifyAssertion({
				clientDataJSON: bytes(credential.response.clientDataJSON),
				authenticatorData: bytes(credential.response.authenticatorData),
				signature: bytes(credential.response.signature),
				publicKey: stored.publicKey,
				storedSignCount: stored.signCount,
				expectedChallenge: challenge,
				expectedOrigin: rp.origin,
				expectedRpId: rp.id,
			});
		} catch (error) {
			return failure(error, "sign-in", 401);
		}
		const user = await findUser(db, eq(users.id, stored.userId));
		if (!user || user.disabled) return { ok: false, status: 403, error: "Account disabled", code: "disabled" };

		// Only move the counter forward, so two racing sign-ins cannot wind it back.
		await db
			.update(passkeys)
			.set({ signCount: verified.signCount, backedUp: verified.backedUp, lastUsedAt: new Date() })
			.where(
				verified.signCount > 0
					? and(eq(passkeys.id, stored.id), lt(passkeys.signCount, verified.signCount))
					: eq(passkeys.id, stored.id),
			);
		return { ok: true, value: { userId: user.id, passkeyId: stored.id, passkeyName: stored.name } };
	});
}

function capMessage(): string {
	return `You can have up to ${MAX_PASSKEYS_PER_USER} passkeys. Remove one first.`;
}

/**
 * Inserts the passkey only while the user has fewer than the maximum, in one statement, so parallel registrations
 * cannot pass the cap together. The unique credential id refuses the same passkey twice even under a race.
 */
async function insertWithinCap(
	env: CloudflareEnv,
	row: Omit<typeof passkeys.$inferInsert, "createdAt" | "lastUsedAt">,
): Promise<"inserted" | "cap" | "duplicate"> {
	try {
		const result = await env.DB.prepare(
			`INSERT INTO passkeys (id, user_id, credential_id, public_key, algorithm, sign_count, transports, aaguid,
				backup_eligible, backed_up, name, created_at)
			SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
			WHERE (SELECT count(*) FROM passkeys WHERE user_id = ?) < ?`,
		)
			.bind(
				row.id,
				row.userId,
				row.credentialId,
				row.publicKey,
				row.algorithm,
				row.signCount ?? 0,
				row.transports ?? null,
				row.aaguid ?? null,
				row.backupEligible ? 1 : 0,
				row.backedUp ? 1 : 0,
				row.name,
				Math.floor(Date.now() / 1000),
				row.userId,
				MAX_PASSKEYS_PER_USER,
			)
			.run();
		return (result.meta.changes ?? 0) > 0 ? "inserted" : "cap";
	} catch (error) {
		if (hasUniqueCause(error)) return "duplicate";
		throw error;
	}
}

function hasUniqueCause(error: unknown): boolean {
	for (let depth = 0; depth < 5 && error; depth++) {
		if (/UNIQUE constraint failed/i.test(error instanceof Error ? error.message : String(error))) return true;
		error = (error as { cause?: unknown }).cause;
	}
	return false;
}

function failure(
	error: unknown,
	ceremony: string,
	status = 400,
): { ok: false; status: number; error: string; code: string } {
	if (error instanceof WebAuthnError) {
		console.warn(`Passkey ${ceremony} refused`, { code: error.code });
		return { ok: false, status, error: passkeyErrorMessage(error.code), code: error.code };
	}
	if (error instanceof TypeError)
		return { ok: false, status: 400, error: passkeyErrorMessage("malformed"), code: "malformed" };
	throw error;
}

/** Removes one of the user's own passkeys; returns its name, or null when there is no such passkey. */
export async function removePasskey(env: CloudflareEnv, userId: string, id: string): Promise<string | null> {
	return guard(async () => {
		const [row] = await getDb(env)
			.delete(passkeys)
			.where(and(eq(passkeys.id, id), eq(passkeys.userId, userId)))
			.returning({ name: passkeys.name });
		return row?.name ?? null;
	});
}

/** Every passkey of a user, for an admin's reset of their second factors. A missing table means there are none. */
export async function deleteUserPasskeys(env: CloudflareEnv, userId: string): Promise<number> {
	try {
		const rows = await getDb(env).delete(passkeys).where(eq(passkeys.userId, userId)).returning({ id: passkeys.id });
		return rows.length;
	} catch (error) {
		if (isNoSuchTableError(error)) return 0;
		throw error;
	}
}
