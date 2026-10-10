import { getEnv } from "@/lib/cloudflare";
import { requireSessionUser } from "@/lib/api/auth";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { AgentActionError } from "@/lib/agent/auto-read/action-error";
import { undoAgentAction } from "@/lib/agent/auto-read/execute";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
	const env = getEnv();
	const { user, error } = await requireSessionUser(env, request);
	if (error) return error;
	if (!hasValidSessionMutationOrigin(request)) return Response.json({ error: "Invalid origin" }, { status: 403 });
	const { id } = await params;
	try {
		return Response.json(await undoAgentAction(env, user, id));
	} catch (caught) {
		if (caught instanceof AgentActionError) return Response.json({ error: caught.message }, { status: caught.status });
		throw caught;
	}
}
