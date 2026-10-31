import { requireSessionAdmin } from "@/lib/api/auth";
import { isPrimaryAdmin } from "@/lib/auth/admin";
import { getEnv } from "@/lib/cloudflare";
import { loadAiFailureReport } from "@/lib/agent/ai-failure-report";

/**
 * The last day's failed AI requests grouped by cause with a fix each, for the overview's Why?: codes, providers,
 * models and times, never a person, a mailbox, a prompt or an answer. No model is asked.
 */
export async function GET(request: Request) {
	const env = getEnv();
	const auth = await requireSessionAdmin(env, request, isPrimaryAdmin);
	if (auth.error) return auth.error;
	return Response.json(await loadAiFailureReport(env), { headers: { "Cache-Control": "no-store" } });
}
