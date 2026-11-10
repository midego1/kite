import { getEnv } from "@/lib/cloudflare";
import { metadataJson, metadataPreflight, OAUTH_SUPPORTED_SCOPES } from "@/lib/mcp/oauth/http";
import { oauthIssuer, protectedResourceMetadata } from "@/lib/mcp/oauth/utils";

/** RFC 9728 §3.1: the Protected Resource Metadata of `/mcp`, at the well-known path followed by the resource's path. */
export function GET(request: Request) {
	return metadataJson(protectedResourceMetadata(oauthIssuer(getEnv().APP_URL, request.url), OAUTH_SUPPORTED_SCOPES));
}

export const OPTIONS = metadataPreflight;

export const dynamic = "force-dynamic";
