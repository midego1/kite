import { z } from "zod";
import { getEnv } from "@/lib/cloudflare";
import { requireSessionUser } from "@/lib/api/auth";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { undoChatAgentAction } from "@/lib/agent/actions";
import { AgentActionError } from "@/lib/agent/auto-read/action-error";

const schema = z.object({ toolMessageId: z.string().min(1) });

/** Undoes an action the user approved in chat; the chat's tool result is marked undone. */
export async function POST(request: Request) {
	const env = getEnv();
	const { user, error } = await requireSessionUser(env, request);
	if (error) return error;
	if (!hasValidSessionMutationOrigin(request)) return Response.json({ error: "Invalid origin" }, { status: 403 });
	const parsed = schema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) return Response.json({ error: "Invalid request" }, { status: 400 });
	try {
		return Response.json(await undoChatAgentAction(env, user, parsed.data.toolMessageId));
	} catch (cause) {
		const status = cause instanceof AgentActionError ? cause.status : 409;
		return Response.json({ error: cause instanceof Error ? cause.message : "Could not undo action" }, { status });
	}
}
