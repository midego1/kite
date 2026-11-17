import { createLogger } from "@/lib/logger.mjs";
import { openSetting, SecretBoxError, sealSetting } from "@/lib/security/secret-box";
import { ExternalAccountRefusal } from "./errors";
import {
	readStoredOAuthClient,
	replaceStoredMicrosoftClient,
	type StoredClientProvider,
	writeStoredOAuthClient,
} from "./oauth-store";
import type { MicrosoftClientStatus } from "./types";
import {
	clientCheckVerdict,
	type ClientCheck,
	isTenant,
	isTenantDomain,
	type MicrosoftClient,
	microsoftEndpoints,
	oauthRedirectUri,
	oauthTestOrigin,
	parseStoredMicrosoftClient,
	tokenRequestBody,
} from "./oauth-utils";

const logger = createLogger("external");

export type ClientEnv = Pick<
	CloudflareEnv,
	| "DB"
	| "APP_ENCRYPTION_KEY"
	| "APP_URL"
	| "MICROSOFT_OAUTH_CLIENT_ID"
	| "MICROSOFT_OAUTH_CLIENT_SECRET"
	| "MICROSOFT_OAUTH_TENANT"
	| "GOOGLE_OAUTH_CLIENT_ID"
	| "GOOGLE_OAUTH_CLIENT_SECRET"
	| "GOOGLE_OAUTH_HOSTED_DOMAIN"
	| "EXTERNAL_OAUTH_TEST_ORIGIN"
>;

/** The registration from the environment, when both its ID and secret are set. */
function envClient(env: ClientEnv): MicrosoftClient | null {
	const clientId = env.MICROSOFT_OAUTH_CLIENT_ID?.trim().toLowerCase();
	const clientSecret = env.MICROSOFT_OAUTH_CLIENT_SECRET?.trim();
	if (!clientId || !clientSecret) return null;
	const tenant = env.MICROSOFT_OAUTH_TENANT?.trim().toLowerCase() || "common";
	return { clientId, clientSecret, tenant: isTenant(tenant) ? tenant : "common" };
}

export type SavedClient<T> = { client: T | null; unreadable: boolean; migrationPending: boolean };

/** A provider's OAuth client saved in Admin → General, opened and parsed; unreadable when the key cannot open it. */
export async function readSavedClient<T>(
	env: ClientEnv,
	provider: StoredClientProvider,
	parse: (json: string | null) => T | null,
): Promise<SavedClient<T>> {
	const stored = await readStoredOAuthClient(env, provider);
	if (stored === undefined) return { client: null, unreadable: false, migrationPending: true };
	if (!stored) return { client: null, unreadable: false, migrationPending: false };
	try {
		return { client: parse(await openSetting(env, stored)), unreadable: false, migrationPending: false };
	} catch (error) {
		if (!(error instanceof SecretBoxError)) throw error;
		logger.warn("external.oauth_client_unreadable", { provider });
		return { client: null, unreadable: true, migrationPending: false };
	}
}

const readSavedMicrosoftClient = (env: ClientEnv) => readSavedClient(env, "microsoft", parseStoredMicrosoftClient);

/** The registration sign-ins and refreshes use: the environment's, else the one saved in Admin → General. */
export async function resolveMicrosoftClient(env: ClientEnv): Promise<MicrosoftClient | null> {
	return envClient(env) ?? (await readSavedMicrosoftClient(env)).client;
}

export async function microsoftClientStatus(env: ClientEnv, requestOrigin: string): Promise<MicrosoftClientStatus> {
	const fromEnv = envClient(env);
	const saved = await readSavedMicrosoftClient(env);
	const client = fromEnv ?? saved.client;
	return {
		source: fromEnv ? "env" : saved.client ? "settings" : null,
		clientId: client?.clientId ?? null,
		tenant: client?.tenant ?? null,
		redirectUri: oauthRedirectUri(env.APP_URL, requestOrigin),
		appUrlSet: !!env.APP_URL?.trim(),
		unreadable: !fromEnv && saved.unreadable,
		keyConfigured: !!env.APP_ENCRYPTION_KEY?.trim(),
		migrationPending: saved.migrationPending,
	};
}

/**
 * For a registration saved with a tenant domain, remembers the tenant ID of its first successful sign-in and
 * returns the ID that is pinned now, so a later sign-in from another tenant is refused (`idTokenClaims`). A
 * registration in the environment, or with a tenant ID or name, has nothing to pin and answers null. The write only
 * lands while the saved registration is still the one that was read, so entering it again (which clears the pin)
 * is never overwritten, and of two first sign-ins racing, the one that lost reads the winner's ID back.
 */
export async function pinMicrosoftTenant(
	env: ClientEnv,
	client: MicrosoftClient,
	tenantId: string,
): Promise<string | null> {
	if (envClient(env) || !isTenantDomain(client.tenant)) return null;
	const stored = await readStoredOAuthClient(env, "microsoft");
	if (!stored) return null;
	try {
		const saved = parseStoredMicrosoftClient(await openSetting(env, stored));
		if (!saved || saved.tenant !== client.tenant) return null;
		if (!saved.tenantId) {
			const sealed = await sealSetting(env, JSON.stringify({ ...saved, tenantId }));
			await replaceStoredMicrosoftClient(env, stored, sealed, new Date());
		}
	} catch (error) {
		if (!(error instanceof SecretBoxError)) throw error;
		return null;
	}
	return (await readSavedMicrosoftClient(env)).client?.tenantId ?? null;
}

/** `fetch`, sent to the loopback stand-in for Microsoft when `EXTERNAL_OAUTH_TEST_ORIGIN` allows it. */
export function oauthTestOriginFor(env: Pick<CloudflareEnv, "EXTERNAL_OAUTH_TEST_ORIGIN">): string | null {
	return oauthTestOrigin(env.EXTERNAL_OAUTH_TEST_ORIGIN, process.env.NODE_ENV);
}

/** How long a request to a provider's token endpoint may take. */
export const TOKEN_REQUEST_TIMEOUT_MS = 15_000;

/**
 * Redeems a made-up authorization code with an OAuth client at a token endpoint, which refuses it either way, and
 * answers the status and body for the provider's verdict; null when the endpoint could not be reached. Nothing is
 * created at the provider.
 */
export async function redeemMadeUpCode(
	tokenUrl: string,
	body: URLSearchParams,
	fetcher: typeof fetch = fetch,
): Promise<{ status: number; body: unknown } | null> {
	try {
		const response = await fetcher(tokenUrl, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
			body,
			redirect: "manual",
			signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
		});
		return { status: response.status, body: await response.json().catch(() => null) };
	} catch {
		return null;
	}
}

/** The made-up code and PKCE verifier a check redeems; no provider ever issued them. */
export const CHECK_GRANT = {
	kind: "authorization_code",
	code: "kite-registration-check",
	verifier: "kite-registration-check-0000000000000000000000000",
} as const;

/**
 * Checks a registration before it is saved: redeems a made-up authorization code with it, which Microsoft refuses
 * either way, and reads why (`clientCheckVerdict`). Nothing is created at Microsoft.
 */
export async function validateMicrosoftClient(
	env: ClientEnv,
	client: MicrosoftClient,
	redirectUri: string,
	fetcher: typeof fetch = fetch,
): Promise<ClientCheck> {
	const endpoints = microsoftEndpoints(client.tenant, oauthTestOriginFor(env));
	const answer = await redeemMadeUpCode(
		endpoints.token,
		tokenRequestBody(client, { ...CHECK_GRANT, redirectUri }),
		fetcher,
	);
	return answer ? clientCheckVerdict(answer.status, answer.body) : { verdict: "unverified" };
}

/**
 * Saves a provider's OAuth client sealed. Refused without APP_ENCRYPTION_KEY: the client secret is only ever stored
 * sealed.
 */
export async function saveSealedClient(env: ClientEnv, provider: StoredClientProvider, client: object): Promise<void> {
	if (!env.APP_ENCRYPTION_KEY?.trim())
		throw new ExternalAccountRefusal(
			409,
			"Set APP_ENCRYPTION_KEY first. Kite only ever saves the client secret encrypted.",
			"NO_KEY",
		);
	await writeStoredOAuthClient(env, provider, await sealSetting(env, JSON.stringify(client)), new Date());
}

/** Saves the registration sealed. Refused without APP_ENCRYPTION_KEY: the client secret is only ever stored sealed. */
export function saveMicrosoftClient(env: ClientEnv, client: MicrosoftClient): Promise<void> {
	return saveSealedClient(env, "microsoft", client);
}

export async function clearMicrosoftClient(env: ClientEnv): Promise<void> {
	await writeStoredOAuthClient(env, "microsoft", null, new Date());
}
