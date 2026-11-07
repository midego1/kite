import { z } from "zod";
import { getEnv } from "@/lib/cloudflare";
import { getCurrentUser } from "@/lib/auth/cookies";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { confirmAgentAction } from "@/lib/agent/actions";
import { proposalEditsSchema } from "@/lib/agent/chat-actions-utils";

/** `edits` are the user's changes on a module tool's card, applied only to the keys its `approval.editable` names. */
const schema = z.object({ toolMessageId: z.string().min(1), edits: proposalEditsSchema.optional() }).strict();

async function readConfirmation(request: Request) {
	const parsed = schema.safeParse(await request.json().catch(() => null));
	return parsed.success ? parsed.data : null;
}

export async function POST(request: Request) {
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
	if (!hasValidSessionMutationOrigin(request)) return Response.json({ error: "Invalid origin" }, { status: 403 });
	const body = await readConfirmation(request);
	if (!body) return Response.json({ error: "Invalid request" }, { status: 400 });
	try {
		return Response.json(await confirmAgentAction(env, user, body.toolMessageId, body.edits));
	} catch (error) {
		return Response.json(
			{ error: error instanceof Error ? error.message : "Could not approve action" },
			{ status: 409 },
		);
	}
}
