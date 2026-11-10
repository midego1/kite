import { getEnv } from "@/lib/cloudflare";
import { authenticateMcpRequest } from "@/lib/mcp/auth";
import { createKiteMcpHandler } from "@/lib/mcp/server";
import { allowAgentRequest } from "@/lib/agent/rate-limit";
import { mcpAuthenticateHeader, mcpResourceUrl, oauthIssuer } from "@/lib/mcp/oauth/utils";

async function handle(request: Request) {
	const url = new URL(request.url);
	const origin = request.headers.get("Origin");
	if (origin && origin !== url.origin) return new Response("Invalid origin", { status: 403 });
	const env = getEnv();
	if (env.APP_URL && url.host !== new URL(env.APP_URL).host) return new Response("Invalid host", { status: 403 });
	const issuer = oauthIssuer(env.APP_URL, request.url);
	const principal = await authenticateMcpRequest(env, request, mcpResourceUrl(issuer));
	// The challenge names the Protected Resource Metadata (RFC 9728 §5.1), where an MCP client finds how to sign in.
	if (!principal)
		return new Response("Unauthorized", {
			status: 401,
			headers: {
				"WWW-Authenticate": mcpAuthenticateHeader(issuer, request.headers.has("Authorization")),
			},
		});
	if (!(await allowAgentRequest(env, `mcp:${principal.keyId}`)))
		return new Response("Rate limit exceeded", { status: 429 });
	const handler = await createKiteMcpHandler(env, principal, url.origin, request.headers.get("Authorization") ?? "");
	try {
		return await handler.fetch(request);
	} finally {
		await handler.close();
	}
}

export const POST = handle;
export const GET = handle;
export const DELETE = handle;
