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
import { revokeToken } from "@/lib/mcp/oauth/service";
import { OAuthError } from "@/lib/mcp/oauth/utils";

const log = createLogger("mcp.oauth");

/** Token revocation (RFC 7009): a client signing out. Unknown tokens answer 200 as well (§2.2). */
export async function POST(request: Request) {
	const env = getEnv();
	if (!(await allowOAuthRequest(env, request, "revoke"))) return rateLimited();
	try {
		const params = await readFormBody(request);
		const token = params.get("token");
		const clientId = params.get("client_id");
		if (!token || !clientId) throw new OAuthError("invalid_request", "token and client_id are required");
		await revokeToken(env, token, clientId);
		return noStoreJson({});
	} catch (error) {
		return oauthFailure(error, log);
	}
}

export const OPTIONS = oauthEndpointPreflight;
