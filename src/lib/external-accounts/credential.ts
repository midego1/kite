import { openSetting, SecretBoxError } from "@/lib/security/secret-box";
import { expireAccessToken } from "./oauth-store";
import { CredentialUnavailableError, oauthAccessToken } from "./oauth-tokens";
import type { ExternalAccountRow } from "./serialize-utils";

export { CredentialUnavailableError } from "./oauth-tokens";

/** What an IMAP or SMTP login carries for an account: its password, or (OAuth) an access token and no password. */
export type AccountCredential = { password: string; accessToken?: string };

type CredentialRow = Pick<ExternalAccountRow, "id" | "authKind" | "secret">;

/** Whether the account signs in with Microsoft (or, later, Google) instead of a password. */
export function signsInWithOAuth(row: Pick<ExternalAccountRow, "authKind">): boolean {
	return row.authKind !== "password";
}

/**
 * The credential of one connection, opened only for it: the saved password, or a current access token (refreshed when
 * needed). Throws `CredentialUnavailableError`; `auth` means the owner has to reconnect.
 */
export async function accountCredential(
	env: CloudflareEnv,
	row: CredentialRow,
	options: { forceRefresh?: boolean } = {},
): Promise<AccountCredential> {
	if (row.authKind === "oauth_microsoft")
		return { password: "", accessToken: await oauthAccessToken(env, row.id, options) };
	if (row.authKind !== "password")
		throw new CredentialUnavailableError("auth", "This kind of sign-in is not supported yet. Reconnect the account.");
	let password: string | null;
	try {
		password = row.secret ? await openSetting(env, row.secret) : null;
	} catch (error) {
		if (!(error instanceof SecretBoxError)) throw error;
		throw new CredentialUnavailableError("auth", "The saved password can no longer be opened. Reconnect the account.");
	}
	if (!password)
		throw new CredentialUnavailableError("auth", "The saved password is no longer available. Reconnect the account.");
	return { password };
}

/** The values to keep out of error text for a credential. */
export function credentialSecrets(credential: AccountCredential): string[] {
	return [credential.password, credential.accessToken ?? ""].filter(Boolean);
}

/**
 * Runs `run` with the account's credential. When a server refuses an OAuth account's cached access token (`refused`
 * says whether an error is such a refusal), the token is refreshed once and `run` runs once more (spec §15.4); a
 * refusal of a fresh token is the caller's to report.
 */
export async function withAccountCredential<T>(
	env: CloudflareEnv,
	row: CredentialRow,
	run: (credential: AccountCredential) => Promise<T>,
	refused: (error: unknown) => boolean,
): Promise<T> {
	const credential = await accountCredential(env, row);
	try {
		return await run(credential);
	} catch (error) {
		if (!signsInWithOAuth(row) || !refused(error)) throw error;
		await expireAccessToken(env, row.id);
		return run(await accountCredential(env, row, { forceRefresh: true }));
	}
}

/** An IMAP sign-in the server refused (not Kite's own refusal before signing in). */
export const imapSignInRefused = (error: unknown) =>
	error instanceof Error && error.name !== "MailServerRefusedError" && /IMAP sign-in failed/i.test(error.message);
