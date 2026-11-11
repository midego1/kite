import { writeStoredOAuthClient } from "./oauth-store";
import {
	CHECK_GRANT,
	type ClientEnv,
	oauthTestOriginFor,
	readSavedClient,
	redeemMadeUpCode,
	saveSealedClient,
} from "./oauth-client";
import {
	type GoogleClient,
	googleClientCheckVerdict,
	googleEndpoints,
	googleTokenRequestBody,
	parseGoogleClientInput,
	parseStoredGoogleClient,
} from "./oauth-google-utils";
import { type ClientCheck, oauthRedirectUri } from "./oauth-utils";
import type { GoogleClientStatus } from "./types";

/** The OAuth client from the environment, when both its ID and secret are set (and well-formed). */
function envGoogleClient(env: ClientEnv): GoogleClient | null {
	if (!env.GOOGLE_OAUTH_CLIENT_ID?.trim() || !env.GOOGLE_OAUTH_CLIENT_SECRET?.trim()) return null;
	const parsed = parseGoogleClientInput({
		clientId: env.GOOGLE_OAUTH_CLIENT_ID,
		clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET,
		hostedDomain: env.GOOGLE_OAUTH_HOSTED_DOMAIN ?? "",
	});
	return parsed.ok ? parsed.client : null;
}

/** Whether the GOOGLE_OAUTH_* variables are set, so they win and Admin → General cannot change Google sign-in. */
export function googleClientFromEnv(env: ClientEnv): boolean {
	return !!(env.GOOGLE_OAUTH_CLIENT_ID?.trim() && env.GOOGLE_OAUTH_CLIENT_SECRET?.trim());
}

const readSavedGoogleClient = (env: ClientEnv) => readSavedClient(env, "google", parseStoredGoogleClient);

/** The OAuth client sign-ins and refreshes use: the environment's, else the one saved in Admin → General. */
export async function resolveGoogleClient(env: ClientEnv): Promise<GoogleClient | null> {
	return envGoogleClient(env) ?? (await readSavedGoogleClient(env)).client;
}

export async function googleClientStatus(env: ClientEnv, requestOrigin: string): Promise<GoogleClientStatus> {
	const fromEnv = envGoogleClient(env);
	const saved = await readSavedGoogleClient(env);
	const client = fromEnv ?? saved.client;
	return {
		source: fromEnv ? "env" : saved.client ? "settings" : null,
		clientId: client?.clientId ?? null,
		hostedDomain: client?.hostedDomain ?? null,
		redirectUri: oauthRedirectUri(env.APP_URL, requestOrigin),
		appUrlSet: !!env.APP_URL?.trim(),
		unreadable: !fromEnv && saved.unreadable,
		keyConfigured: !!env.APP_ENCRYPTION_KEY?.trim(),
		migrationPending: saved.migrationPending,
	};
}

/**
 * Checks an OAuth client before it is saved: redeems a made-up authorization code with it at Google's token endpoint,
 * which Google refuses either way, and reads why (`googleClientCheckVerdict`). Nothing is created at Google.
 */
export async function validateGoogleClient(
	env: ClientEnv,
	client: GoogleClient,
	redirectUri: string,
	fetcher: typeof fetch = fetch,
): Promise<ClientCheck> {
	const answer = await redeemMadeUpCode(
		googleEndpoints(oauthTestOriginFor(env)).token,
		googleTokenRequestBody(client, { ...CHECK_GRANT, redirectUri }),
		fetcher,
	);
	return answer ? googleClientCheckVerdict(answer.status, answer.body) : { verdict: "unverified" };
}

/** Saves the OAuth client sealed. Refused without APP_ENCRYPTION_KEY: the client secret is only ever stored sealed. */
export function saveGoogleClient(env: ClientEnv, client: GoogleClient): Promise<void> {
	return saveSealedClient(env, "google", client);
}

export async function clearGoogleClient(env: ClientEnv): Promise<void> {
	await writeStoredOAuthClient(env, "google", null, new Date());
}
