import { eq, lt } from "drizzle-orm";
import { getDb } from "@/db";
import { passkeyChallenges } from "@/db/schema/passkeys";
import { newId } from "@/lib/ids";
import { hashSessionToken } from "@/lib/auth/session";
import { bytesToBase64Url } from "@/lib/auth/webauthn/base64url-utils";
import { PASSKEY_CHALLENGE_TTL_MS } from "@/lib/auth/passkey-utils";

type Purpose = "register" | "authenticate";

/**
 * Starts a ceremony: 32 random bytes the authenticator must sign, stored server-side under the hash of a separate
 * token the client gets. Registration binds it to the user and their session; sign-in has neither yet.
 */
export async function createPasskeyChallenge(
	env: CloudflareEnv,
	input: { purpose: Purpose; userId?: string; sessionToken?: string },
): Promise<{ token: string; challenge: string }> {
	const db = getDb(env);
	const now = Date.now();
	// Abandoned ceremonies are cleared as new ones start, so the table stays small without a cron task.
	await db.delete(passkeyChallenges).where(lt(passkeyChallenges.expiresAt, new Date(now)));
	const token = newId("pkc");
	const challenge = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
	await db.insert(passkeyChallenges).values({
		id: newId(),
		tokenHash: await hashSessionToken(token),
		purpose: input.purpose,
		challenge,
		userId: input.userId ?? null,
		sessionHash: input.sessionToken ? await hashSessionToken(input.sessionToken) : null,
		expiresAt: new Date(now + PASSKEY_CHALLENGE_TTL_MS),
	});
	return { token, challenge };
}

/**
 * Takes the challenge out of the store in one statement, so it can be answered once even when two requests race,
 * and returns it only when it is unexpired and was issued for this purpose, user and session.
 */
export async function consumePasskeyChallenge(
	env: CloudflareEnv,
	token: string,
	expected: { purpose: Purpose; userId?: string; sessionToken?: string },
): Promise<string | null> {
	const db = getDb(env);
	const [row] = await db
		.delete(passkeyChallenges)
		.where(eq(passkeyChallenges.tokenHash, await hashSessionToken(token)))
		.returning();
	if (!row) return null;
	if (row.purpose !== expected.purpose || row.expiresAt.getTime() <= Date.now()) return null;
	if ((row.userId ?? undefined) !== expected.userId) return null;
	const sessionHash = expected.sessionToken ? await hashSessionToken(expected.sessionToken) : null;
	if (row.sessionHash !== sessionHash) return null;
	return row.challenge;
}
