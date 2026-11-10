import { allKeyScopes, scopeDeclarations } from "@/lib/modules/key-scope-utils";
import { MODULE_MANIFESTS } from "@/lib/modules/registry";
import { isMcpOAuthPending } from "./store";
import { OAuthError, OAUTH_MAX_BODY_BYTES } from "./utils";

/**
 * The scopes an OAuth client may ask for: the MCP key scopes, core and every module's whether it is on or off, as
 * for keys. Administrative scopes are never offered over OAuth.
 */
export const OAUTH_SUPPORTED_SCOPES: readonly string[] = allKeyScopes(scopeDeclarations(MODULE_MANIFESTS), "mcp");

/**
 * Registration, token and revocation take no cookie, so browser-based MCP clients (MCP Inspector) may call them from
 * any origin; a cross-site page gains nothing it could not do with its own HTTP client.
 */
const NO_STORE = { "Cache-Control": "no-store", Pragma: "no-cache", "Access-Control-Allow-Origin": "*" };

/** A JSON answer that no cache keeps (RFC 6749 §5.1). */
export function noStoreJson(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return Response.json(body, { status, headers: { ...NO_STORE, ...headers } });
}

/** The metadata documents are public and carry no secret, so any origin may read them. */
export function metadataJson(body: unknown): Response {
	return Response.json(body, {
		headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=300" },
	});
}

export function metadataPreflight(): Response {
	return new Response(null, {
		status: 204,
		headers: {
			"Access-Control-Allow-Origin": "*",
			"Access-Control-Allow-Methods": "GET, OPTIONS",
			"Access-Control-Allow-Headers": "MCP-Protocol-Version",
		},
	});
}

/** The CORS preflight of the registration, token and revocation endpoints. */
export function oauthEndpointPreflight(): Response {
	return new Response(null, {
		status: 204,
		headers: {
			"Access-Control-Allow-Origin": "*",
			"Access-Control-Allow-Methods": "POST, OPTIONS",
			"Access-Control-Allow-Headers": "Content-Type, MCP-Protocol-Version",
			"Access-Control-Max-Age": "600",
		},
	});
}

/**
 * The answer for anything an OAuth endpoint threw: its OAuth error, 409 `MIGRATION_PENDING` before migration 0106,
 * and a generic server error otherwise (never the database message, which can name values).
 */
export function oauthFailure(
	error: unknown,
	log: { error: (event: string, fields?: Record<string, unknown>) => void },
) {
	if (error instanceof OAuthError)
		return noStoreJson(
			{ error: error.code, error_description: error.description },
			error.status,
			error.code === "invalid_client" ? { "WWW-Authenticate": 'Bearer error="invalid_client"' } : {},
		);
	if (isMcpOAuthPending(error))
		return noStoreJson(
			{
				error: "temporarily_unavailable",
				error_description: "Apply the pending database update first",
				code: "MIGRATION_PENDING",
			},
			409,
		);
	log.error("mcp.oauth.endpoint_failed", { error: error instanceof Error ? error.name : "unknown" });
	return noStoreJson({ error: "server_error", error_description: "Something went wrong" }, 500);
}

/** Registration, token and revocation requests share the login budget per IP, each under its own key. */
export async function allowOAuthRequest(
	env: CloudflareEnv,
	request: Request,
	endpoint: "register" | "token" | "revoke",
): Promise<boolean> {
	if (!env.LOGIN_RATE_LIMIT) return true;
	const ip = request.headers.get("cf-connecting-ip")?.trim() || "unknown";
	try {
		return (await env.LOGIN_RATE_LIMIT.limit({ key: `mcp-oauth-${endpoint}:${ip}` })).success;
	} catch (error) {
		console.warn("MCP OAuth rate limiter unavailable", error);
		return true;
	}
}

export function rateLimited(): Response {
	return noStoreJson({ error: "temporarily_unavailable", error_description: "Too many requests" }, 429, {
		"Retry-After": "60",
	});
}

async function boundedText(request: Request): Promise<string> {
	const length = Number(request.headers.get("Content-Length") ?? 0);
	if (length > OAUTH_MAX_BODY_BYTES) throw new OAuthError("invalid_request", "The request is too large", 413);
	const text = await request.text();
	if (text.length > OAUTH_MAX_BODY_BYTES) throw new OAuthError("invalid_request", "The request is too large", 413);
	return text;
}

/** A JSON object body (registration). */
export async function readJsonBody(request: Request): Promise<unknown> {
	const text = await boundedText(request);
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw new OAuthError("invalid_client_metadata", "The body must be JSON");
	}
}

/**
 * The parameters of a token or revocation request: `application/x-www-form-urlencoded` as RFC 6749 asks, or a JSON
 * object of strings, which some clients send.
 */
export async function readFormBody(request: Request): Promise<{ get(name: string): string | null }> {
	const text = await boundedText(request);
	if (!(request.headers.get("Content-Type") ?? "").includes("application/json")) return new URLSearchParams(text);
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new OAuthError("invalid_request", "The body must be form-encoded");
	}
	const values =
		parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
	return { get: (name) => (typeof values[name] === "string" ? (values[name] as string) : null) };
}
