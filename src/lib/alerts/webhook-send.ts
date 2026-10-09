import type { AlertMessage, ChannelResult } from "./alerts-types";
import { classifyDeliveryError, classifyWebhookResponse, runWithRetry } from "./delivery-utils";
import { checkAlertWebhookTarget, loadAlertWebhook } from "./webhook-settings";
import { buildWebhookRequest, detectWebhookKind } from "./webhook-utils";

const WEBHOOK_TIMEOUT_MS = 10_000;
const WEBHOOK_RETRY_DELAY_MS = 1_000;

type WebhookFailureReason = "timeout" | "network" | "http_status" | "blocked_url" | "unreadable";

export type WebhookSendResult = ChannelResult & { channel: "webhook"; status?: number };

export type WebhookAttemptFailure = {
	attempt: number;
	reason: "timeout" | "network" | "http_status" | "blocked_url";
	status?: number;
	error?: unknown;
};

const BLOCKED = Symbol("blocked");

class WebhookStatusError extends Error {
	constructor(readonly status: number) {
		super(`Alert webhook answered ${status}`);
		this.name = "WebhookStatusError";
	}
}

function describeFailure(error: unknown): Pick<WebhookAttemptFailure, "reason" | "status"> {
	if (error instanceof WebhookStatusError) return { reason: "http_status", status: error.status };
	return { reason: classifyDeliveryError(error) };
}

function failed(reason: WebhookFailureReason, status?: number): WebhookSendResult {
	return { channel: "webhook", outcome: "failed", reason, ...(status === undefined ? {} : { status }) };
}

/**
 * Posts one alert message to the saved webhook. The response body is never read,
 * and neither the URL nor anything the receiver returns is logged or returned.
 */
export async function sendAlertWebhook(
	env: CloudflareEnv,
	message: AlertMessage,
	options: {
		retry: boolean;
		timeoutMs?: number;
		delayMs?: number;
		onAttemptFailed?: (failure: WebhookAttemptFailure) => void;
	},
): Promise<WebhookSendResult> {
	const saved = await loadAlertWebhook(env);
	if (!saved) return { channel: "webhook", outcome: "skipped", reason: "not_configured" };
	if (saved.url === null) return failed("unreadable");
	const url = saved.url;

	// A blocked target resolves to BLOCKED rather than throwing, so runWithRetry
	// stops instead of retrying it as a network error.
	const result = await runWithRetry(
		async (signal, attempt) => {
			let target: URL;
			try {
				target = await checkAlertWebhookTarget(env, url);
			} catch {
				options.onAttemptFailed?.({ attempt, reason: "blocked_url" });
				return BLOCKED;
			}
			const { headers, body } = buildWebhookRequest(detectWebhookKind(target, saved.kind), message);
			try {
				const response = await fetch(target, { method: "POST", redirect: "manual", headers, body, signal });
				await response.body?.cancel().catch(() => undefined);
				if (!classifyWebhookResponse(response.status).ok) throw new WebhookStatusError(response.status);
				return response.status;
			} catch (error) {
				options.onAttemptFailed?.({ attempt, ...describeFailure(error), error });
				throw error;
			}
		},
		{
			attempts: options.retry ? 2 : 1,
			timeoutMs: options.timeoutMs ?? WEBHOOK_TIMEOUT_MS,
			delayMs: options.delayMs ?? WEBHOOK_RETRY_DELAY_MS,
		},
	);
	if (result.ok) {
		if (typeof result.value !== "number") return failed("blocked_url");
		return { channel: "webhook", outcome: "sent", status: result.value };
	}
	const { reason, status } = describeFailure(result.error);
	return failed(reason, status);
}
