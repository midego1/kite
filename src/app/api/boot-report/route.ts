import { NextResponse } from "next/server";
import { requireSessionUser } from "@/lib/api/auth";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { parseBootFreezeReport, readBootReportBody } from "@/lib/boot/report-utils";
import { getEnv } from "@/lib/cloudflare";
import { createLogger } from "@/lib/logger.mjs";

const logger = createLogger("boot");

/** A frozen load is reported once by the next load (and once by the service worker); each user gets the login limiter's budget, so a loop cannot flood the log. */
async function allowReport(env: CloudflareEnv, userId: string): Promise<boolean> {
	if (!env.LOGIN_RATE_LIMIT) return true;
	try {
		return (await env.LOGIN_RATE_LIMIT.limit({ key: `boot-report:${userId}` })).success;
	} catch (error) {
		logger.warn("boot.report_rate_limiter_unavailable", { error });
		return true;
	}
}

/**
 * A load of this tab froze on its startup screen; the next load says so with `navigator.sendBeacon`
 * (boot-trace-utils.ts), and the service worker's freeze watchdog (public/kite-sw.js) says whether it reloaded the
 * tab. Logged as `boot.previous_load_froze`, `boot.auto_reloaded_after_freeze` or `boot.freeze_not_reloaded` for
 * the operator: a frozen page can show nothing, and this is the one record a freeze leaves. Nothing is stored.
 */
export async function POST(request: Request) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
	if (!(await allowReport(env, auth.user.id)))
		return NextResponse.json({ error: "Too many reports", code: "RATE_LIMITED" }, { status: 429 });
	const text = await readBootReportBody(request);
	if (text === null) return NextResponse.json({ error: "Report too large" }, { status: 413 });
	const report = parseBootFreezeReport(text);
	if (!report) return NextResponse.json({ error: "Not a boot report" }, { status: 400 });
	const { event, ...facts } = report;
	logger.warn(`boot.${event}`, {
		userId: auth.user.id,
		...facts,
		userAgent: request.headers.get("User-Agent")?.slice(0, 200) ?? null,
	});
	return new NextResponse(null, { status: 204 });
}
