import { requireSessionAdmin } from "@/lib/api/auth";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { getEnv } from "@/lib/cloudflare";
import { changeUserConnectAccess, loadUserConnectAccess } from "@/lib/external-accounts/admin";
import { answerExternal } from "@/lib/external-accounts/http";

type Params = { params: Promise<{ id: string }> };

/** A user's **Connect accounts** permission and the states of their connected accounts. */
export async function GET(request: Request, { params }: Params) {
	const env = getEnv();
	const auth = await requireSessionAdmin(env, request);
	if (auth.error) return auth.error;
	const { id } = await params;
	return answerExternal(() => loadUserConnectAccess(env, auth.user, id));
}

export async function PUT(request: Request, { params }: Params) {
	const env = getEnv();
	const auth = await requireSessionAdmin(env, request);
	if (auth.error) return auth.error;
	if (!hasValidSessionMutationOrigin(request)) return Response.json({ error: "Invalid origin" }, { status: 403 });
	const body = (await request.json().catch(() => null)) as { allowed?: unknown } | null;
	if (typeof body?.allowed !== "boolean")
		return Response.json({ error: "Send allowed: true or false" }, { status: 400 });
	const allowed = body.allowed;
	const { id } = await params;
	return answerExternal(() => changeUserConnectAccess(env, auth.user, id, allowed));
}
