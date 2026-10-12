import { getEnv } from "@/lib/cloudflare";
import { requireSessionUser } from "@/lib/api/auth";
import { listSuggestions } from "@/lib/agent/auto-read/suggestion-api";
import { parseStatusFilter } from "@/lib/agent/auto-read/suggestion-api-utils";

export async function GET(request: Request) {
	const env = getEnv();
	const { user, error } = await requireSessionUser(env, request);
	if (error) return error;
	const params = new URL(request.url).searchParams;
	const mailboxId = params.get("mailboxId") || null;
	const status = parseStatusFilter(params.get("status"), !!mailboxId);
	if (!status) return Response.json({ error: "Unknown suggestion status" }, { status: 400 });
	const result = await listSuggestions(env, user, {
		mailboxId,
		status,
		messageId: params.get("messageId"),
		threadId: params.get("threadId"),
	});
	// Suggestions are for full-access users only; everyone else cannot tell the mailbox has any.
	if (!result) return Response.json({ error: "Mailbox not found" }, { status: 404 });
	return Response.json(result);
}
