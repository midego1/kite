import { requireSessionAdmin } from "@/lib/api/auth";
import { isPrimaryAdmin } from "@/lib/auth/admin";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { getEnv } from "@/lib/cloudflare";
import { readJsonBody } from "@/lib/http/request";
import { auditOAuthClient } from "./audit";
import { ExternalAccountRefusal } from "./errors";
import { answerExternal } from "./http";
import type { ClientEnv } from "./oauth-client";
import { isOAuthMigrationPending } from "./oauth-store";
import { type ClientCheck, oauthRedirectUri } from "./oauth-utils";

const NO_STORE = { "Cache-Control": "no-store" };

/** One provider's OAuth client as Admin → General manages it (`/api/admin/external-accounts/<provider>`). */
export type OAuthClientRouteConfig<Client> = {
	provider: "microsoft" | "google";
	/** Refusal while the provider's environment variables are set (they win). */
	envWins: string;
	/** Answer before the migration that adds the client's column. */
	pending: string;
	/** Warning when the provider could not be reached to check the client, which was saved anyway. */
	unverified: string;
	fromEnv(env: ClientEnv): boolean;
	status(env: ClientEnv, requestOrigin: string): Promise<Record<string, unknown>>;
	parse(body: unknown): { ok: true; client: Client } | { ok: false; error: string };
	validate(env: ClientEnv, client: Client, redirectUri: string): Promise<ClientCheck>;
	save(env: ClientEnv, client: Client): Promise<void>;
	clear(env: ClientEnv): Promise<void>;
	/** What the audit row keeps of a saved client: never its secret. */
	auditDetails(client: Client): { clientId?: string; tenant?: string; hostedDomain?: string | null };
};

/**
 * The owner-only handlers of an OAuth client (spec §15.1): `GET` the status (never the secret), `PUT` check it with the
 * provider and save it sealed, `DELETE` remove it. Primary admin only, and mutations only from this site and while
 * the provider's environment variables do not win.
 */
export function oauthClientRoutes<Client>(config: OAuthClientRouteConfig<Client>) {
	async function authorize(
		request: Request,
		mutation: boolean,
	): Promise<{ env: CloudflareEnv; userId: string; error: null } | { error: Response }> {
		const env = getEnv();
		const auth = await requireSessionAdmin(env, request, isPrimaryAdmin);
		if (auth.error) return { error: auth.error };
		if (mutation && !hasValidSessionMutationOrigin(request))
			return { error: Response.json({ error: "Invalid origin" }, { status: 403, headers: NO_STORE }) };
		if (mutation && config.fromEnv(env))
			return { error: Response.json({ error: config.envWins }, { status: 409, headers: NO_STORE }) };
		return { env, userId: auth.user.id, error: null };
	}

	function pendingAnswer(error: unknown): Response {
		if (!isOAuthMigrationPending(error)) throw error;
		return Response.json({ error: config.pending, code: "MIGRATION_PENDING" }, { status: 409, headers: NO_STORE });
	}

	async function GET(request: Request): Promise<Response> {
		const access = await authorize(request, false);
		if (access.error) return access.error;
		return answerExternal(async () => config.status(access.env, new URL(request.url).origin));
	}

	async function PUT(request: Request): Promise<Response> {
		const access = await authorize(request, true);
		if (access.error) return access.error;
		const input = config.parse(await readJsonBody<Record<string, unknown>>(request, 8 * 1024).catch(() => null));
		if (!input.ok) return Response.json({ error: input.error }, { status: 400, headers: NO_STORE });
		const origin = new URL(request.url).origin;
		const check = await config.validate(access.env, input.client, oauthRedirectUri(access.env.APP_URL, origin));
		if (check.verdict === "rejected") return Response.json({ error: check.error }, { status: 400, headers: NO_STORE });
		try {
			await config.save(access.env, input.client);
		} catch (error) {
			if (error instanceof ExternalAccountRefusal)
				return Response.json({ error: error.message, code: error.code }, { status: error.status, headers: NO_STORE });
			return pendingAnswer(error);
		}
		await auditOAuthClient(access.env, access.userId, config.provider, "saved", config.auditDetails(input.client));
		return answerExternal(async () => ({
			status: await config.status(access.env, origin),
			...(check.verdict === "unverified" ? { warning: config.unverified } : {}),
		}));
	}

	async function DELETE(request: Request): Promise<Response> {
		const access = await authorize(request, true);
		if (access.error) return access.error;
		try {
			await config.clear(access.env);
		} catch (error) {
			return pendingAnswer(error);
		}
		await auditOAuthClient(access.env, access.userId, config.provider, "removed", {});
		return answerExternal(async () => ({ status: await config.status(access.env, new URL(request.url).origin) }));
	}

	return { GET, PUT, DELETE };
}
