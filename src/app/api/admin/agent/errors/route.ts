import { requireSessionAdmin } from "@/lib/api/auth";
import { isPrimaryAdmin } from "@/lib/auth/admin";
import { getEnv } from "@/lib/cloudflare";
import { listRecentAiErrors } from "@/lib/agent/ai-errors";

/** The last 20 failed AI requests for Admin → Agent: codes, models and numbers, never prompts or answers. */
export async function GET(request: Request) {
	const env = getEnv();
	const auth = await requireSessionAdmin(env, request, isPrimaryAdmin);
	if (auth.error) return auth.error;
	return Response.json({ errors: await listRecentAiErrors(env) }, { headers: { "Cache-Control": "no-store" } });
}
