import { oauthTestOriginFor, pinMicrosoftTenant, resolveMicrosoftClient, type ClientEnv } from "./oauth-client";
import { resolveGoogleClient } from "./oauth-google-client";
import {
	googleAuthorizeUrl,
	googleEndpoints,
	googleIdTokenClaims,
	googleTokenRequestBody,
	grantsGmail,
} from "./oauth-google-utils";
import { OAUTH_PROVIDERS, type OAuthProviderId, type OAuthProviderInfo } from "./oauth-provider-utils";
import {
	grantsImap,
	idTokenClaims,
	isTenantDomain,
	microsoftAuthorizeUrl,
	microsoftEndpoints,
	type OAuthEndpoints,
	type OAuthIdentity,
	type TokenGrant,
	tokenRequestBody,
} from "./oauth-utils";

/** Why the ID token of a sign-in names nobody Kite may connect: no usable address, or outside the allowed domain. */
type IdentityRefusal = "no_address" | "wrong_domain";

/**
 * One provider's OAuth client, ready for a sign-in or a refresh (spec §15): its endpoints, its token request bodies,
 * its authorize URL, and how its ID token names the user. Everything the flow and the token code need, so neither
 * branches on the provider.
 */
export type OAuthApp = {
	provider: OAuthProviderInfo;
	clientId: string;
	endpoints: OAuthEndpoints;
	tokenBody(grant: TokenGrant): URLSearchParams;
	authorizeUrl(input: { redirectUri: string; state: string; challenge: string; loginHint: string | null }): string;
	/** The identity in the code redemption's ID token, checked against this client. */
	identity(idToken: string | null): Promise<OAuthIdentity | IdentityRefusal>;
	/** Whether the scopes granted let Kite read mail over IMAP. */
	grantsMail(scopes: string): boolean;
};

async function microsoftApp(env: ClientEnv): Promise<OAuthApp | null> {
	const client = await resolveMicrosoftClient(env);
	if (!client) return null;
	const endpoints = microsoftEndpoints(client.tenant, oauthTestOriginFor(env));
	return {
		provider: OAUTH_PROVIDERS.microsoft,
		clientId: client.clientId,
		endpoints,
		tokenBody: (grant) => tokenRequestBody(client, grant),
		authorizeUrl: (input) => microsoftAuthorizeUrl({ ...input, endpoints, clientId: client.clientId }),
		async identity(idToken) {
			const claims = idTokenClaims(idToken, client.clientId, client.tenant, client.tenantId);
			if (!claims) return "no_address";
			// A tenant given as a domain is pinned to the first sign-in's tenant ID; a first sign-in racing another one
			// from a different tenant reads the winner's ID back here and is refused like any token of the wrong tenant.
			if (isTenantDomain(client.tenant) && !client.tenantId) {
				const pinned = await pinMicrosoftTenant(env, client, claims.tenantId);
				if (pinned && pinned !== claims.tenantId) return "no_address";
			}
			return { address: claims.address, subject: claims.subject };
		},
		grantsMail: grantsImap,
	};
}

async function googleApp(env: ClientEnv): Promise<OAuthApp | null> {
	const client = await resolveGoogleClient(env);
	if (!client) return null;
	const endpoints = googleEndpoints(oauthTestOriginFor(env));
	return {
		provider: OAUTH_PROVIDERS.google,
		clientId: client.clientId,
		endpoints,
		tokenBody: (grant) => googleTokenRequestBody(client, grant),
		authorizeUrl: (input) =>
			googleAuthorizeUrl({ ...input, endpoints, clientId: client.clientId, hostedDomain: client.hostedDomain }),
		async identity(idToken) {
			const checked = googleIdTokenClaims(idToken, client, new Date());
			return checked.ok ? checked.identity : checked.reason;
		},
		grantsMail: grantsGmail,
	};
}

/** The provider's OAuth client as set up by the owner (or the environment), or null when it is not set up. */
export function resolveOAuthApp(env: ClientEnv, provider: OAuthProviderId): Promise<OAuthApp | null> {
	return provider === "google" ? googleApp(env) : microsoftApp(env);
}
