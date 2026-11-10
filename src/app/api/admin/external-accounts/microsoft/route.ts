import { requireSessionAdmin } from "@/lib/api/auth";
import { isPrimaryAdmin } from "@/lib/auth/admin";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { getEnv } from "@/lib/cloudflare";
import { answerExternal } from "@/lib/external-accounts/http";
import {
	clearMicrosoftClient,
	microsoftClientStatus,
	saveMicrosoftClient,
	validateMicrosoftClient,
} from "@/lib/external-accounts/oauth-client";
import { auditMicrosoftClient } from "@/lib/external-accounts/audit";
import { ExternalAccountRefusal } from "@/lib/external-accounts/errors";
import { isOAuthMigrationPending } from "@/lib/external-accounts/oauth-store";
import { oauthRedirectUri, parseMicrosoftClientInput } from "@/lib/external-accounts/oauth-utils";
import { readJsonBody } from "@/lib/http/request";

const NO_STORE = { "Cache-Control": "no-store" };
const ENV_WINS =
	"Microsoft sign-in is set with the MICROSOFT_OAUTH_CLIENT_ID and MICROSOFT_OAUTH_CLIENT_SECRET variables, which take precedence. Remove them to manage it here.";
const PENDING = "Apply the pending database update before setting up Microsoft sign-in.";
const UNVERIFIED_WARNING =
	"Microsoft could not be reached, so the registration was saved without a check. Connecting an account will show whether it works.";

/** Owner only, from this site; `mutation` also refuses while the environment's registration wins. */
async function authorize(request: Request, mutation: boolean) {
	const env = getEnv();
	const auth = await requireSessionAdmin(env, request, isPrimaryAdmin);
	if (auth.error) return { env, user: null, error: auth.error };
	if (!mutation) return { env, user: auth.user, error: null };
	if (!hasValidSessionMutationOrigin(request))
		return { env, user: null, error: Response.json({ error: "Invalid origin" }, { status: 403, headers: NO_STORE }) };
	if (env.MICROSOFT_OAUTH_CLIENT_ID?.trim() && env.MICROSOFT_OAUTH_CLIENT_SECRET?.trim())
		return { env, user: null, error: Response.json({ error: ENV_WINS }, { status: 409, headers: NO_STORE }) };
	return { env, user: auth.user, error: null };
}

function pendingAnswer(error: unknown): Response {
	if (!isOAuthMigrationPending(error)) throw error;
	return Response.json({ error: PENDING, code: "MIGRATION_PENDING" }, { status: 409, headers: NO_STORE });
}

/** Where Microsoft sign-in stands (Admin → General): the client ID, tenant and redirect URI, never the secret. */
export async function GET(request: Request) {
	const access = await authorize(request, false);
	if (access.error) return access.error;
	return answerExternal(async () => microsoftClientStatus(access.env, new URL(request.url).origin));
}

/** Checks the registration with Microsoft, then saves it sealed with APP_ENCRYPTION_KEY. The secret is never sent back. */
export async function PUT(request: Request) {
	const access = await authorize(request, true);
	if (access.error || !access.user) return access.error;
	const body = await readJsonBody<Record<string, unknown>>(request, 8 * 1024).catch(() => null);
	const input = parseMicrosoftClientInput(body);
	if (!input.ok) return Response.json({ error: input.error }, { status: 400, headers: NO_STORE });
	const origin = new URL(request.url).origin;
	const check = await validateMicrosoftClient(access.env, input.client, oauthRedirectUri(access.env.APP_URL, origin));
	if (check.verdict === "rejected") return Response.json({ error: check.error }, { status: 400, headers: NO_STORE });
	try {
		await saveMicrosoftClient(access.env, input.client);
	} catch (error) {
		if (error instanceof ExternalAccountRefusal)
			return Response.json({ error: error.message, code: error.code }, { status: error.status, headers: NO_STORE });
		return pendingAnswer(error);
	}
	await auditMicrosoftClient(access.env, access.user.id, "saved", {
		clientId: input.client.clientId,
		tenant: input.client.tenant,
	});
	return answerExternal(async () => ({
		status: await microsoftClientStatus(access.env, origin),
		...(check.verdict === "unverified" ? { warning: UNVERIFIED_WARNING } : {}),
	}));
}

export async function DELETE(request: Request) {
	const access = await authorize(request, true);
	if (access.error || !access.user) return access.error;
	try {
		await clearMicrosoftClient(access.env);
	} catch (error) {
		return pendingAnswer(error);
	}
	await auditMicrosoftClient(access.env, access.user.id, "removed", {});
	return answerExternal(async () => ({ status: await microsoftClientStatus(access.env, new URL(request.url).origin) }));
}
