import { getEnv } from "@/lib/cloudflare";
import { metadataJson, metadataPreflight, OAUTH_SUPPORTED_SCOPES } from "@/lib/mcp/oauth/http";
import { authorizationServerMetadata, oauthIssuer } from "@/lib/mcp/oauth/utils";

/** RFC 8414 Authorization Server Metadata: Kite is its own authorization server for `/mcp`. */
export function GET(request: Request) {
	return metadataJson(authorizationServerMetadata(oauthIssuer(getEnv().APP_URL, request.url), OAUTH_SUPPORTED_SCOPES));
}

export const OPTIONS = metadataPreflight;

export const dynamic = "force-dynamic";
