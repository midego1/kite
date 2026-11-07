import { requireSessionUser } from "@/lib/api/auth";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { getEnv } from "@/lib/cloudflare";
import { answerExternal } from "@/lib/external-accounts/http";
import { readTwoWayView, saveTwoWay } from "@/lib/external-accounts/two-way";
import { readJsonBody } from "@/lib/http/request";

type Params = { params: Promise<{ id: string }> };

/**
 * The account's two-way sync settings and what its server supports (spec §6.8); only its owner gets them.
 * `?support=stored` answers from what is stored and never asks the server, for the closed row's summary.
 */
export async function GET(request: Request, { params }: Params) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	const { id } = await params;
	const storedOnly = new URL(request.url).searchParams.get("support") === "stored";
	return answerExternal(async () => ({ twoWay: await readTwoWayView(env, auth.user, id, { storedOnly }) }));
}

/** Saves them; a choice the server cannot carry out is refused. */
export async function PUT(request: Request, { params }: Params) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	if (!hasValidSessionMutationOrigin(request)) return Response.json({ error: "Invalid origin" }, { status: 403 });
	const body = await readJsonBody<Record<string, unknown>>(request, 4 * 1024).catch(() => null);
	if (!body || typeof body !== "object") return Response.json({ error: "Invalid request" }, { status: 400 });
	const { id } = await params;
	return answerExternal(async () => ({ twoWay: await saveTwoWay(env, auth.user, id, body) }));
}
