import { traceHttp } from "./src/lib/trace.mjs";
import { recordMetric, statusClass } from "./src/lib/metrics.mjs";
import { routeTemplate } from "./src/lib/metrics-route-utils";
import { createLogger } from "./src/lib/logger.mjs";

import vinextHandler from "vinext/server/fetch-handler";
import { processInboundMessage, storeRawToR2, type InboundQueueMessage } from "./src/lib/email/inbound";
import { processOutboundQueue, type OutboundQueueMessage } from "./src/lib/email/send";
import { describeQueueMessage, isInboundQueueMessage, isWebhookRetryMessage, queueMetric } from "./worker-utils";
import { processWebhookRetry, type WebhookRetryMessage } from "./src/lib/email/webhooks";
import { processMailboxPurge } from "./src/lib/mailboxes/delete";
import { isMailboxPurgeMessage } from "./src/lib/mailboxes/delete-utils";
import { resolveIncomingMail, forwardMessage } from "./src/lib/email/incoming";
import { getUserFromSession } from "./src/lib/auth/session";
import { getSessionTokenFromRequest } from "./src/lib/realtime/utils";
import { inboundAttachmentLimitReasonFromRaw } from "./src/lib/email/inbound-attachments";
import { hasValidSessionMutationOrigin } from "./src/lib/auth/origin";
import { checkCsrf } from "./src/lib/security/csrf";
import { buildContentSecurityPolicy, createCspNonce, isDocumentPath } from "./src/lib/security/headers";
import { getAccountForwardingDestination, wasForwardedByKite } from "./src/lib/email/account-forwarding";
import { runScheduledDatabaseBackup } from "./src/lib/backups/runner";
import { processAgentDraftJob } from "./src/lib/agent/jobs/utils";
import { runAgentMaintenance } from "./src/lib/agent/maintenance";
import { runTrashRetention } from "./src/lib/email/trash-retention";
import { runDatabasePruning } from "./src/lib/maintenance/pruning";
import { runOperationalAlerts } from "./src/lib/alerts/run";
import { isImportJobQueueMessage, processImportJob, resumeStalledImportJobs } from "./src/lib/import/jobs";
export { RealtimeHub } from "./src/lib/realtime/hub";

const logger = createLogger("worker");

/**
 * vinext reads the nonce from the request's Content-Security-Policy header and
 * puts it on the scripts it renders; the root layout reads `x-nonce` for its own.
 */
async function renderDocumentWithCsp(request: Request, env: CloudflareEnv, ctx: ExecutionContext): Promise<Response> {
	const dev = process.env.NODE_ENV !== "production";
	const nonce = dev ? undefined : createCspNonce();
	const policy = buildContentSecurityPolicy({ nonce, dev });
	const headers = new Headers(request.headers);
	headers.set("Content-Security-Policy", policy);
	if (nonce) headers.set("x-nonce", nonce);
	else headers.delete("x-nonce");
	const response = await vinextHandler.fetch(new Request(request, { headers }), env, ctx);
	if (response.status === 101) return response;
	const withPolicy = new Response(response.body, response);
	withPolicy.headers.set("Content-Security-Policy", policy);
	return withPolicy;
}

async function handleFetch(request: Request, env: CloudflareEnv, ctx: ExecutionContext): Promise<Response> {
	const url = new URL(request.url);
	if (url.pathname === "/api/realtime") {
		if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
			return new Response("Expected WebSocket upgrade", { status: 426 });
		}
		if (!hasValidSessionMutationOrigin(request)) {
			return new Response("Invalid origin", { status: 403 });
		}

		const user = await getUserFromSession(env, getSessionTokenFromRequest(request));
		if (!user || user.disabled) {
			return new Response("Unauthorized", { status: 401 });
		}

		const hub = env.REALTIME.getByName(user.id);
		const hubRequest = new Request("https://kite-realtime/connect", request);
		hubRequest.headers.set("X-Kite-Realtime-User", user.id);
		return hub.fetch(hubRequest);
	}

	const csrfRejection = checkCsrf(request, env.APP_URL);
	if (csrfRejection) return csrfRejection;

	if (!isDocumentPath(url.pathname)) return vinextHandler.fetch(request, env, ctx);
	return renderDocumentWithCsp(request, env, ctx);
}

export default {
	async fetch(request: Request, env: CloudflareEnv, ctx: ExecutionContext) {
		if (!new URL(request.url).pathname.startsWith("/api/")) return handleFetch(request, env, ctx);
		const name = routeTemplate(new URL(request.url).pathname);
		return traceHttp(
			request,
			(traced) => handleFetch(traced, env, ctx),
			logger,
			({ status, durationMs, failed }) =>
				recordMetric(env.METRICS, {
					event: "http",
					service: "kite",
					name,
					detail: request.method,
					statusClass: statusClass(status),
					status,
					durationMs,
					outcome: failed ? "exception" : "ok",
					version: env.CF_VERSION_METADATA?.id ?? "",
				}),
		);
	},

	async email(message: ForwardableEmailMessage, env: CloudflareEnv, _ctx: ExecutionContext) {
		// Where the handler stopped and which R2 object it wrote, for the failure log.
		let stage: "route" | "read_raw" | "forward" | "store" | "enqueue" = "route";
		let rawR2Key: string | undefined;
		try {
			if (message.rawSize > 25 * 1024 * 1024) {
				message.setReject(
					"Message rejected: raw email exceeds the 25 MiB receiving limit. Send a download link instead.",
				);
				return;
			}
			// Domain routing rules are resolved here rather than in the queue because reject and
			// forward can only be actioned on the live ForwardableEmailMessage.
			const decision = await resolveIncomingMail(env, message.from, message.to);

			if (decision?.action === "reject") {
				message.setReject(decision.rejectReason ?? "Message rejected by routing rule");
				return;
			}
			stage = "read_raw";
			const raw = await new Response(message.raw).arrayBuffer();
			const attachmentLimitReason = await inboundAttachmentLimitReasonFromRaw(raw);
			if (attachmentLimitReason) {
				message.setReject(attachmentLimitReason);
				return;
			}

			stage = "forward";
			if (decision?.action === "forward" && decision.forwardTo) {
				const forwarded = await forwardMessage(message, decision.forwardTo);
				// A forward rule drops the message unless it was explicitly asked to keep a copy.
				// If the forward itself failed we still store it, so mail is never silently lost.
				if (forwarded && !decision.keepCopy) return;
			}

			if (!wasForwardedByKite((name) => message.headers.get(name))) {
				const forwardingDestination = await getAccountForwardingDestination(env, message.to);
				if (forwardingDestination) {
					await forwardMessage(message, forwardingDestination);
				}
			}
			stage = "store";
			rawR2Key = await storeRawToR2(env, message.from, message.to, raw);
			const payload: InboundQueueMessage = {
				from: message.from,
				to: message.to,
				rawR2Key,
				headers: Object.fromEntries(message.headers),
			};
			stage = "enqueue";
			await env.INBOUND_QUEUE.send(payload);
		} catch (err) {
			logger.error("inbound.enqueue_failed", { stage, rawSize: message.rawSize, rawR2Key, error: err });
			message.setReject("Processing failed");
		}
	},

	async queue(batch: MessageBatch, env: CloudflareEnv): Promise<void> {
		for (const msg of batch.messages) {
			const started = performance.now();
			const version = env.CF_VERSION_METADATA?.id ?? "";
			try {
				if (isInboundQueueMessage(msg.body)) {
					await processInboundMessage(env, msg.body);
				} else if (
					typeof msg.body === "object" &&
					msg.body !== null &&
					(msg.body as { kind?: unknown }).kind === "agent.draft" &&
					typeof (msg.body as { jobId?: unknown }).jobId === "string"
				) {
					await processAgentDraftJob(env, (msg.body as { jobId: string }).jobId);
				} else if (isImportJobQueueMessage(msg.body)) {
					await processImportJob(env, msg.body.jobId);
				} else if (isWebhookRetryMessage(msg.body)) {
					await processWebhookRetry(env, msg.body as WebhookRetryMessage);
				} else if (isMailboxPurgeMessage(msg.body)) {
					await processMailboxPurge(env, msg.body);
				} else if (
					typeof msg.body === "object" &&
					msg.body !== null &&
					(msg.body as { kind?: unknown }).kind === "email.scheduled"
				) {
					await processOutboundQueue(env, msg.body as OutboundQueueMessage);
				} else {
					throw new Error("Unknown queue message type");
				}
				msg.ack();
				recordMetric(
					env.METRICS,
					queueMetric(msg.body, batch.queue, "ack", Math.round(performance.now() - started), msg.attempts, version),
				);
			} catch (err) {
				logger.error("queue.processing_failed", {
					queue: batch.queue,
					messageId: msg.id,
					attempts: msg.attempts,
					...describeQueueMessage(msg.body),
					error: err,
				});
				recordMetric(
					env.METRICS,
					queueMetric(msg.body, batch.queue, "retry", Math.round(performance.now() - started), msg.attempts, version),
				);
				msg.retry({ delaySeconds: 10 });
			}
		}
	},

	async scheduled(controller: ScheduledController, env: CloudflareEnv, ctx: ExecutionContext) {
		if (controller.cron === "0 2 * * *") {
			const now = new Date(controller.scheduledTime);
			// Prune after the backup so the snapshot still holds the rows being removed.
			ctx.waitUntil(
				runScheduledDatabaseBackup(env, now)
					.catch((error) => logger.error("backup.scheduled_failed", { error }))
					.then(() => runDatabasePruning(env, now))
					.catch((error) => logger.error("database.pruning_failed", { error })),
			);
		}
		// Only the 5-minute trigger: both crons fire at 02:00 and a backup may still be running then.
		if (controller.cron === "*/5 * * * *") {
			ctx.waitUntil(
				runOperationalAlerts(env, new Date(controller.scheduledTime)).catch((error) =>
					logger.error("alerts.evaluation_failed", { error }),
				),
			);
		}
		ctx.waitUntil(runAgentMaintenance(env));
		ctx.waitUntil(runTrashRetention(env, new Date(controller.scheduledTime)));
		ctx.waitUntil(resumeStalledImportJobs(env));
	},
} satisfies ExportedHandler<CloudflareEnv>;
