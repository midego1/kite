import { getEnv } from "@/lib/cloudflare";
import { createLogger } from "@/lib/logger.mjs";
import {
	allowOAuthRequest,
	noStoreJson,
	oauthEndpointPreflight,
	oauthFailure,
	rateLimited,
	readJsonBody,
} from "@/lib/mcp/oauth/http";
import { registerClient } from "@/lib/mcp/oauth/service";
import { parseClientRegistration, registrationResponse } from "@/lib/mcp/oauth/utils";

const log = createLogger("mcp.oauth");

/** Dynamic Client Registration (RFC 7591) for public MCP clients. It grants nothing until a user consents. */
export async function POST(request: Request) {
	const env = getEnv();
	if (!(await allowOAuthRequest(env, request, "register"))) return rateLimited();
	try {
		const now = new Date();
		const client = await registerClient(
			env,
			parseClientRegistration(await readJsonBody(request)),
			now,
			request.headers.get("cf-connecting-ip"),
		);
		return noStoreJson(registrationResponse(client, now), 201);
	} catch (error) {
		return oauthFailure(error, log);
	}
}

export const OPTIONS = oauthEndpointPreflight;
