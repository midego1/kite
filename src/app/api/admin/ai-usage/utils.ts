import { getEnv } from "@/lib/cloudflare";
import { requireSessionUser } from "@/lib/api/auth";
import { isPrimaryAdmin } from "@/lib/auth/admin";
import { loadUsageActivity, loadUsageReport } from "@/lib/ai/usage-report";
import { parseUsageQuery } from "@/lib/ai/usage-report-utils";
import { getRequestTimeZone } from "@/lib/time/utils";

export async function GET(request: Request) {
	const env = getEnv();
	const session = await requireSessionUser(env, request);
	if (session.error) return session.error;
	if (!isPrimaryAdmin(session.user)) return Response.json({ error: "Forbidden" }, { status: 403 });
	const query = parseUsageQuery(new URL(request.url).searchParams);
	if ("error" in query) return Response.json({ error: query.error }, { status: 400 });
	const timeZone = getRequestTimeZone(request, session.user.timeZone);
	const report = query.activityOnly
		? await loadUsageActivity(env, session.user, query, timeZone)
		: await loadUsageReport(env, session.user, query, timeZone);
	return Response.json(report, { headers: { "Cache-Control": "no-store" } });
}
