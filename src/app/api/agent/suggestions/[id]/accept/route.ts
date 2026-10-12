import { getEnv } from "@/lib/cloudflare";
import { requireSessionUser } from "@/lib/api/auth";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { agentActionResponse } from "@/lib/agent/auto-read/action-response";
import { acceptSuggestion } from "@/lib/agent/auto-read/suggestion-api";
import { isValidTimeZone, normalizeTimeZone } from "@/lib/time/utils";
import { acceptSuggestionSchema } from "@/lib/agent/auto-read/suggestion-api-utils";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
	const env = getEnv();
	const { user, error } = await requireSessionUser(env, request);
	if (error) return error;
	if (!hasValidSessionMutationOrigin(request)) return Response.json({ error: "Invalid origin" }, { status: 403 });
	const parsed = acceptSuggestionSchema.safeParse(await request.json().catch(() => null));
	const { id } = await params;
	// A missing option is refused after the access check, so users without full access always get 404.
	const header = request.headers.get("X-Time-Zone");
	const deviceTimeZone = header && isValidTimeZone(header) ? normalizeTimeZone(header) : null;
	return agentActionResponse(() =>
		acceptSuggestion(env, user, id, parsed.success ? parsed.data.option : "", deviceTimeZone),
	);
}
