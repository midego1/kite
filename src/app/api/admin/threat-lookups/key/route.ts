import { getEnv } from "@/lib/cloudflare";
import { requireSessionAdmin } from "@/lib/api/auth";
import { isPrimaryAdmin } from "@/lib/auth/admin";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { abuseChFetcher, testAbuseChKey } from "@/lib/spam/providers/abuse-ch";
import {
	AbuseChKeyUpdatePendingError,
	clearAbuseChKey,
	getAbuseChKeyStatus,
	saveAbuseChKey,
} from "@/lib/spam/providers/abuse-ch-key";
import { abuseChAuthKey, keySaveDecision, parseAbuseChKeyInput } from "@/lib/spam/providers/abuse-ch-utils";

const NO_STORE = { "Cache-Control": "no-store" };
const SECRET_WINS =
	"The key is set as a secret, which takes precedence. Remove the URLHAUS_AUTH_KEY or ABUSE_CH_AUTH_KEY secret to manage the key here.";
const UNVERIFIED_WARNING =
	"abuse.ch could not be reached, so the key was saved without a check. Press Test key later to check it.";

async function authorize(request: Request) {
	const env = getEnv();
	const auth = await requireSessionAdmin(env, request, isPrimaryAdmin);
	if (auth.error) return { env, error: auth.error };
	if (!hasValidSessionMutationOrigin(request))
		return { env, error: Response.json({ error: "Invalid origin" }, { status: 403, headers: NO_STORE }) };
	if (abuseChAuthKey(env))
		return { env, error: Response.json({ error: SECRET_WINS }, { status: 409, headers: NO_STORE }) };
	return { env, error: null };
}

function updatePending(error: unknown) {
	if (!(error instanceof AbuseChKeyUpdatePendingError)) throw error;
	return Response.json({ error: error.message }, { status: 409, headers: NO_STORE });
}

/** Owner only: checks the key on both lists, then saves it sealed. The key is never sent back. */
export async function PUT(request: Request) {
	const access = await authorize(request);
	if (access.error) return access.error;
	const body = (await request.json().catch(() => null)) as { authKey?: unknown } | null;
	const key = parseAbuseChKeyInput(body?.authKey);
	if (!key) return Response.json({ error: "Enter an abuse.ch Auth-Key" }, { status: 400, headers: NO_STORE });
	const results = await testAbuseChKey(key, abuseChFetcher(access.env));
	const decision = keySaveDecision(results);
	if (decision === "rejected")
		return Response.json(
			{ error: "Key rejected: abuse.ch refused this Auth-Key. Check it and try again.", results },
			{ status: 400, headers: NO_STORE },
		);
	try {
		await saveAbuseChKey(access.env, key);
	} catch (error) {
		return updatePending(error);
	}
	return Response.json(
		{
			status: await getAbuseChKeyStatus(access.env),
			results,
			...(decision === "unverified" ? { warning: UNVERIFIED_WARNING } : {}),
		},
		{ headers: NO_STORE },
	);
}

export async function DELETE(request: Request) {
	const access = await authorize(request);
	if (access.error) return access.error;
	try {
		await clearAbuseChKey(access.env);
	} catch (error) {
		return updatePending(error);
	}
	return Response.json({ status: await getAbuseChKeyStatus(access.env) }, { headers: NO_STORE });
}
