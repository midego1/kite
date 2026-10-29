import { requireSessionUser } from "@/lib/api/auth";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { getEnv } from "@/lib/cloudflare";
import { answerExternal } from "@/lib/external-accounts/http";
import { removeExternalAccount, updateExternalAccount } from "@/lib/external-accounts/service";
import { readJsonBody } from "@/lib/http/request";

type Params = { params: Promise<{ id: string }> };

/** Edits an account; a new password or server needs the Kite password and a successful test. */
export async function PATCH(request: Request, { params }: Params) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	if (!hasValidSessionMutationOrigin(request)) return Response.json({ error: "Invalid origin" }, { status: 403 });
	const body = await readJsonBody<Record<string, unknown>>(request, 16 * 1024).catch(() => null);
	if (!body || typeof body !== "object") return Response.json({ error: "Invalid request" }, { status: 400 });
	const { id } = await params;
	return answerExternal(async () => ({ account: await updateExternalAccount(env, auth.user, id, body) }));
}

/** Removes an account and its saved password; its mail stays in Kite. */
export async function DELETE(request: Request, { params }: Params) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	if (!hasValidSessionMutationOrigin(request)) return Response.json({ error: "Invalid origin" }, { status: 403 });
	const { id } = await params;
	return answerExternal(async () => {
		await removeExternalAccount(env, auth.user, id);
		return { ok: true };
	});
}
