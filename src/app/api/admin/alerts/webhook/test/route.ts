import { createLogger } from "@/lib/logger.mjs";
import { sendAlertWebhook } from "@/lib/alerts/webhook-send";
import { buildTestAlertMessage } from "@/lib/alerts/webhook-utils";
import { authorizeAlertWebhook, NOT_CONFIGURED, noStoreJson } from "../utils";

const logger = createLogger("alerts");

/** One attempt, no retry and no email: this only proves the saved webhook answers. */
export async function POST(request: Request) {
	const access = await authorizeAlertWebhook(request, true);
	if (access.error) return access.error;
	const message = buildTestAlertMessage({ appName: "Kite", appUrl: access.env.APP_URL, sentAt: new Date() });
	const result = await sendAlertWebhook(access.env, message, { retry: false });
	if (result.outcome === "skipped") return noStoreJson({ error: NOT_CONFIGURED }, 400);
	const ok = result.outcome === "sent";
	logger.info("alerts.webhook_test", { ok, reason: result.reason ?? null });
	if (ok) return noStoreJson({ ok: true, status: result.status });
	return noStoreJson(
		{ ok: false, reason: result.reason, ...(result.status === undefined ? {} : { status: result.status }) },
		502,
	);
}
