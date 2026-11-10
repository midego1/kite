import { getEnv } from "@/lib/cloudflare";
import { createLogger } from "@/lib/logger.mjs";
import {
	allowOAuthRequest,
	noStoreJson,
	oauthEndpointPreflight,
	oauthFailure,
	rateLimited,
	readFormBody,
} from "@/lib/mcp/oauth/http";
import { exchangeAuthorizationCode, refreshTokens } from "@/lib/mcp/oauth/service";
import { OAuthError } from "@/lib/mcp/oauth/utils";

const log = createLogger("mcp.oauth");

/** The token endpoint (OAuth 2.1 §3.2): authorization codes with PKCE, and refresh tokens, for public clients. */
export async function POST(request: Request) {
	const env = getEnv();
	if (!(await allowOAuthRequest(env, request, "token"))) return rateLimited();
	try {
		const params = await readFormBody(request);
		const now = new Date();
		const grantType = params.get("grant_type");
		if (grantType === "authorization_code")
			return noStoreJson(
				await exchangeAuthorizationCode(
					env,
					{
						clientId: params.get("client_id"),
						code: params.get("code"),
						redirectUri: params.get("redirect_uri"),
						codeVerifier: params.get("code_verifier"),
						resource: params.get("resource"),
					},
					now,
				),
			);
		if (grantType === "refresh_token")
			return noStoreJson(
				await refreshTokens(
					env,
					{
						clientId: params.get("client_id"),
						refreshToken: params.get("refresh_token"),
						resource: params.get("resource"),
						scope: params.get("scope"),
					},
					now,
				),
			);
		throw new OAuthError("unsupported_grant_type", "Use authorization_code or refresh_token");
	} catch (error) {
		return oauthFailure(error, log);
	}
}

export const OPTIONS = oauthEndpointPreflight;
