import { requireSessionUser } from "@/lib/api/auth";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { getEnv } from "@/lib/cloudflare";
import { CONNECT_REFUSAL_TEXT, connectRefusal } from "@/lib/external-accounts/access";
import { answerExternal } from "@/lib/external-accounts/http";
import { EXTERNAL_ACCOUNT_PRESETS } from "@/lib/external-accounts/presets-utils";
import { connectExternalAccount, listExternalAccounts } from "@/lib/external-accounts/service";
import { readJsonBody } from "@/lib/http/request";

const presets = EXTERNAL_ACCOUNT_PRESETS.map(({ id, label, imap, smtp, passwordSignIn, passwordHelp }) => ({
	id,
	label,
	imap,
	smtp,
	passwordSignIn,
	passwordHelp,
}));

/** The user's connected accounts (never their passwords), whether they may connect one, and the provider presets. */
export async function GET(request: Request) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	return answerExternal(
		async () => {
			const refusal = await connectRefusal(env, auth.user.id);
			const accounts = refusal === "migration_pending" ? [] : await listExternalAccounts(env, auth.user.id);
			return {
				accounts,
				refusal,
				refusalText: refusal ? CONNECT_REFUSAL_TEXT[refusal] : null,
				presets,
				migrationPending: refusal === "migration_pending",
			};
		},
		{ whenPending: { accounts: [], refusal: "migration_pending", presets } },
	);
}

/** Connects an account: needs the Kite password and a successful IMAP sign-in (spec §11). */
export async function POST(request: Request) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	if (!hasValidSessionMutationOrigin(request)) return Response.json({ error: "Invalid origin" }, { status: 403 });
	const body = await readJsonBody<Record<string, unknown>>(request, 16 * 1024).catch(() => null);
	if (!body || typeof body !== "object") return Response.json({ error: "Invalid request" }, { status: 400 });
	return answerExternal(async () => ({ account: await connectExternalAccount(env, auth.user, body) }), { status: 201 });
}
