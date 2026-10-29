import { requireSessionAdmin } from "@/lib/api/auth";
import { isPrimaryAdmin } from "@/lib/auth/admin";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { getEnv } from "@/lib/cloudflare";
import { changeInstallSwitch, loadInstallSwitch } from "@/lib/external-accounts/admin";
import { answerExternal } from "@/lib/external-accounts/http";

/** **Allow connected accounts** (Admin → General), the owner's switch for the whole install. */
export async function GET(request: Request) {
	const env = getEnv();
	const auth = await requireSessionAdmin(env, request, isPrimaryAdmin);
	if (auth.error) return auth.error;
	return answerExternal(() => loadInstallSwitch(env));
}

export async function PUT(request: Request) {
	const env = getEnv();
	const auth = await requireSessionAdmin(env, request, isPrimaryAdmin);
	if (auth.error) return auth.error;
	if (!hasValidSessionMutationOrigin(request)) return Response.json({ error: "Invalid origin" }, { status: 403 });
	const body = (await request.json().catch(() => null)) as { enabled?: unknown } | null;
	if (typeof body?.enabled !== "boolean")
		return Response.json({ error: "Send enabled: true or false" }, { status: 400 });
	const enabled = body.enabled;
	return answerExternal(() => changeInstallSwitch(env, auth.user, enabled));
}
