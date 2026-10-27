import { requireSessionUser } from "@/lib/api/auth";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { getEnv } from "@/lib/cloudflare";
import { InteractiveModelRefusedError, type InteractiveRefusal } from "@/lib/agent/interactive-model";
import { allowAgentRequest } from "@/lib/agent/rate-limit";
import { createSummary, getSummaryState, SummaryRefusal } from "@/lib/agent/summaries/service";
import { primaryLanguage } from "@/lib/agent/summaries/summary-utils";
import { readJsonBody } from "@/lib/http/request";
import { summaryQuerySchema, summaryRequestSchema } from "./schema";

type RouteParams = { params: Promise<{ messageId: string }> };

const NO_STORE = { "Cache-Control": "no-store" };

const REFUSALS: Record<InteractiveRefusal, { status: number; error: string; code: string }> = {
	assistant_disabled: { status: 403, error: "Assistant is disabled", code: "assistant_off" },
	external_provider_not_allowed: {
		status: 403,
		error: "The primary admin has not allowed the external AI provider to read mail",
		code: "external_provider_not_allowed",
	},
	not_configured: { status: 503, error: "AI provider is not configured", code: "no_provider" },
};

function refused(error: unknown) {
	if (error instanceof SummaryRefusal)
		return Response.json({ error: error.message, code: error.code }, { status: error.status, headers: NO_STORE });
	if (error instanceof InteractiveModelRefusedError) {
		const { status, ...body } = REFUSALS[error.reason];
		return Response.json(body, { status, headers: NO_STORE });
	}
	throw error;
}

/** The cached summary of a conversation or message for this user, whether it is out of date, and its translation. */
export async function GET(request: Request, { params }: RouteParams) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	const url = new URL(request.url);
	const parsed = summaryQuerySchema.safeParse({
		scope: url.searchParams.get("scope") ?? undefined,
		language: url.searchParams.get("language"),
	});
	if (!parsed.success) return Response.json({ error: "Invalid request" }, { status: 400 });
	const { messageId } = await params;
	try {
		const state = await getSummaryState(env, auth.user, messageId, {
			scope: parsed.data.scope,
			language: primaryLanguage(parsed.data.language),
		});
		return Response.json(state, { headers: NO_STORE });
	} catch (error) {
		return refused(error);
	}
}

/** Makes the summary (or, with `translateTo`, its translation) on demand; a current one is returned as it is. */
export async function POST(request: Request, { params }: RouteParams) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	if (!hasValidSessionMutationOrigin(request)) return Response.json({ error: "Invalid origin" }, { status: 403 });
	const parsed = summaryRequestSchema.safeParse(await readJsonBody(request, 4_000).catch(() => null));
	if (!parsed.success) return Response.json({ error: "Invalid request" }, { status: 400 });
	if (!(await allowAgentRequest(env, `summary:${auth.user.id}`)))
		return Response.json(
			{ error: "Too many requests. Wait a moment and try again.", code: "rate_limited" },
			{ status: 429, headers: NO_STORE },
		);
	const { messageId } = await params;
	try {
		const state = await createSummary(env, auth.user, messageId, {
			scope: parsed.data.scope,
			language: primaryLanguage(parsed.data.language),
			translateTo: parsed.data.translateTo ?? null,
		});
		return Response.json(state, { headers: NO_STORE });
	} catch (error) {
		return refused(error);
	}
}
