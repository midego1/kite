import { requireSessionUser } from "@/lib/api/auth";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { getEnv } from "@/lib/cloudflare";
import { reportAiErrorClass } from "@/lib/agent/ai-errors";
import { allowAgentRequest } from "@/lib/agent/rate-limit";
import { NO_STORE, refused } from "@/lib/agent/summaries/model-answer";
import { createTranslation, getTranslationState } from "@/lib/agent/translation/service";
import { readJsonBody } from "@/lib/http/request";
import { translationQuerySchema, translationRequestSchema } from "./schema";

type RouteParams = { params: Promise<{ messageId: string }> };

/** The kept translation of a message into `target`, if there is one; never a model call. */
export async function GET(request: Request, { params }: RouteParams) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	const parsed = translationQuerySchema.safeParse({ target: new URL(request.url).searchParams.get("target") });
	if (!parsed.success) return Response.json({ error: "Invalid request" }, { status: 400 });
	const { messageId } = await params;
	try {
		return Response.json(await getTranslationState(env, auth.user, messageId, parsed.data.target), {
			headers: NO_STORE,
		});
	} catch (error) {
		return refused(error);
	}
}

/** Translates the message on demand; one already kept is returned as it is. */
export async function POST(request: Request, { params }: RouteParams) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	if (!hasValidSessionMutationOrigin(request)) return Response.json({ error: "Invalid origin" }, { status: 403 });
	const parsed = translationRequestSchema.safeParse(await readJsonBody(request, 4_000).catch(() => null));
	if (!parsed.success) return Response.json({ error: "Invalid request" }, { status: 400 });
	if (!(await allowAgentRequest(env, `translation:${auth.user.id}`))) {
		const body = await reportAiErrorClass(
			{ code: "rate_limited", status: null },
			{ env, feature: "message_translation", userId: auth.user.id },
		);
		return Response.json(body, { status: 429, headers: NO_STORE });
	}
	const { messageId } = await params;
	try {
		const state = await createTranslation(env, auth.user, messageId, {
			target: parsed.data.target,
			quoted: parsed.data.quoted ?? false,
		});
		return Response.json(state, { headers: NO_STORE });
	} catch (error) {
		return refused(error);
	}
}
