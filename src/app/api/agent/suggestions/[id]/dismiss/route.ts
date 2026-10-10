import { getEnv } from "@/lib/cloudflare";
import { requireSessionUser } from "@/lib/api/auth";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { agentActionResponse } from "@/lib/agent/auto-read/action-response";
import { dismissSuggestion } from "@/lib/agent/auto-read/suggestion-api";
import { dismissSuggestionSchema } from "@/lib/agent/auto-read/suggestion-api-utils";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
	const env = getEnv();
	const { user, error } = await requireSessionUser(env, request);
	if (error) return error;
	if (!hasValidSessionMutationOrigin(request)) return Response.json({ error: "Invalid origin" }, { status: 403 });
	const text = await request.text().catch(() => "");
	let body: unknown = {};
	try {
		body = text.trim() ? JSON.parse(text) : {};
	} catch {
		body = null;
	}
	const parsed = dismissSuggestionSchema.safeParse(body);
	const { id } = await params;
	return agentActionResponse(() => dismissSuggestion(env, user, id, parsed.success ? parsed.data : null));
}
