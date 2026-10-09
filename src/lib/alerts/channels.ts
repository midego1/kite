import { and, asc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { sendSystemEmail } from "@/lib/email/system-mail";
import { createLogger } from "../logger.mjs";
import type { ActiveAlert, ChannelResult } from "./alerts-types";
import { classifyDeliveryError, runWithRetry } from "./delivery-utils";
import { renderAlertEmail } from "./rules-utils";
import { sendAlertWebhook } from "./webhook-send";
import { buildAlertMessage } from "./webhook-utils";

const logger = createLogger("alerts");

const APP_NAME = "Kite";
const EMAIL_TIMEOUT_MS = 15_000;
const RETRY_DELAY_MS = 1_000;

export type AlertDeliveryOptions = {
	delayMs?: number;
	emailTimeoutMs?: number;
	webhookTimeoutMs?: number;
};

type Channel = ChannelResult["channel"];

/** Only the channel, attempt and reason are logged; never the URL, host, recipient or a response body. */
function logChannelFailure(
	channel: Channel,
	failure: { attempt: number; reason: string; status?: number; error?: unknown },
): void {
	logger.warn("alerts.channel_failed", {
		channel,
		attempt: failure.attempt,
		reason: failure.reason,
		...(failure.status === undefined ? {} : { status: failure.status }),
		...(failure.error === undefined ? {} : { error: failure.error }),
	});
}

async function findAlertRecipient(env: CloudflareEnv): Promise<string | null> {
	const [admin] = await getDb(env)
		.select({ email: users.email, resetEmail: users.resetEmail })
		.from(users)
		.where(and(eq(users.role, "admin"), eq(users.isPrimaryAdmin, true), eq(users.disabled, false)))
		.orderBy(asc(users.createdAt))
		.limit(1);
	return admin ? (admin.resetEmail ?? admin.email) : null;
}

/** sendSystemEmail takes no signal, so the attempt rejects on abort to let the timeout be logged as a failed attempt. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		signal.addEventListener("abort", () => reject(signal.reason), { once: true });
		promise.then(resolve, reject);
	});
}

function emailFailureReason(error: unknown): string {
	return classifyDeliveryError(error) === "timeout" ? "timeout" : "send_error";
}

async function deliverEmail(
	env: CloudflareEnv,
	alerts: ActiveAlert[],
	options: AlertDeliveryOptions,
): Promise<ChannelResult> {
	const recipient = await findAlertRecipient(env);
	if (!recipient) return { channel: "email", outcome: "skipped", reason: "no_recipient" };
	const { subject, text } = renderAlertEmail(alerts, { appName: APP_NAME, appUrl: env.APP_URL });
	const result = await runWithRetry(
		async (signal, attempt) => {
			try {
				return await untilAborted(sendSystemEmail(env, { to: recipient, subject, text }), signal);
			} catch (error) {
				logChannelFailure("email", { attempt, reason: emailFailureReason(error), error });
				throw error;
			}
		},
		{
			attempts: 2,
			timeoutMs: options.emailTimeoutMs ?? EMAIL_TIMEOUT_MS,
			delayMs: options.delayMs ?? RETRY_DELAY_MS,
		},
	);
	if (!result.ok) return { channel: "email", outcome: "failed", reason: emailFailureReason(result.error) };
	return result.value
		? { channel: "email", outcome: "sent" }
		: { channel: "email", outcome: "skipped", reason: "no_sender" };
}

async function deliverWebhook(
	env: CloudflareEnv,
	alerts: ActiveAlert[],
	now: Date,
	options: AlertDeliveryOptions,
): Promise<ChannelResult> {
	const message = buildAlertMessage(alerts, { appName: APP_NAME, appUrl: env.APP_URL, sentAt: now });
	let attemptsLogged = 0;
	const result = await sendAlertWebhook(env, message, {
		retry: true,
		timeoutMs: options.webhookTimeoutMs,
		delayMs: options.delayMs ?? RETRY_DELAY_MS,
		onAttemptFailed: (failure) => {
			attemptsLogged++;
			logChannelFailure("webhook", failure);
		},
	});
	// An unreadable or blocked URL fails before any request is made.
	if (result.outcome === "failed" && attemptsLogged === 0) {
		logChannelFailure("webhook", { attempt: 1, reason: result.reason ?? "error" });
	}
	const { status: _status, ...channelResult } = result;
	return channelResult;
}

function settle(channel: Channel, outcome: PromiseSettledResult<ChannelResult>): ChannelResult {
	if (outcome.status === "fulfilled") return outcome.value;
	logChannelFailure(channel, { attempt: 1, reason: "error", error: outcome.reason });
	return { channel, outcome: "failed", reason: "error" };
}

/** Email and webhook run side by side; a failure or throw in one never stops the other. */
export async function deliverAlertChannels(
	env: CloudflareEnv,
	alerts: ActiveAlert[],
	ctx: { now: Date } & AlertDeliveryOptions,
): Promise<ChannelResult[]> {
	const [email, webhook] = await Promise.allSettled([
		deliverEmail(env, alerts, ctx),
		deliverWebhook(env, alerts, ctx.now, ctx),
	]);
	return [settle("email", email), settle("webhook", webhook)];
}
