import { NextResponse } from "next/server";
import { requireSessionUser } from "@/lib/api/auth";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { getEnv } from "@/lib/cloudflare";
import { createLogger } from "@/lib/logger.mjs";
import { deleteGrant, isMcpOAuthPending, listGrants, ownsGrant } from "@/lib/mcp/oauth/store";
import { redirectUriHost } from "@/lib/mcp/oauth/utils";

const log = createLogger("mcp.oauth");

/** The MCP apps the signed-in user connected with OAuth; empty, with `migrationPending`, before migration 0106. */
export async function GET(request: Request) {
	const env = getEnv();
	const { user, error } = await requireSessionUser(env, request);
	if (error) return error;
	try {
		const grants = await listGrants(env, user.id);
		return NextResponse.json({
			apps: grants.map(({ redirectUri, createdAt, lastUsedAt, ...grant }) => ({
				...grant,
				redirectHost: redirectUriHost(redirectUri),
				createdAt: new Date(createdAt * 1000).toISOString(),
				lastUsedAt: lastUsedAt === null ? null : new Date(lastUsedAt * 1000).toISOString(),
			})),
		});
	} catch (cause) {
		if (isMcpOAuthPending(cause)) return NextResponse.json({ apps: [], migrationPending: true });
		throw cause;
	}
}

/** Disconnects one app: its tokens stop working at once and its pending send requests are cancelled. */
export async function DELETE(request: Request) {
	const env = getEnv();
	const { user, error } = await requireSessionUser(env, request);
	if (error) return error;
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
	const id = new URL(request.url).searchParams.get("id");
	if (!id) return NextResponse.json({ error: "App required" }, { status: 400 });
	try {
		if (!(await ownsGrant(env, user.id, id))) return NextResponse.json({ error: "App not found" }, { status: 404 });
		await deleteGrant(env, id);
		log.info("mcp.oauth.grant_revoked", { keyId: id });
		return NextResponse.json({ ok: true });
	} catch (cause) {
		if (isMcpOAuthPending(cause))
			return NextResponse.json(
				{ error: "Apply the pending database update first", code: "MIGRATION_PENDING" },
				{ status: 409 },
			);
		throw cause;
	}
}
