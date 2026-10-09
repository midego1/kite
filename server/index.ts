import { createLogger } from "../src/lib/logger.mjs";
import { createTraceContext, logRequestCompleted } from "../src/lib/trace.mjs";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { join, resolve } from "node:path";
import { parse } from "node:url";
import next from "next";
import { WebSocketServer } from "ws";
import { getUserFromSession } from "@/lib/auth/session";
import { getSessionTokenFromRequest } from "@/lib/realtime/utils";
import { hasAdminAccount } from "@/lib/auth/setup";
import { getAllowedMutationHosts, isAllowedMutationRequest, requiresCsrfCheck } from "@/lib/security/csrf";
import { isTrustProxyEnabled, resolveClientIp } from "@/lib/security/client-ip";
import { buildContentSecurityPolicy, createCspNonce, isDocumentPath } from "@/lib/security/headers";
import { processInboundMessage } from "@/lib/email/inbound";
import { processAgentDraftJob } from "@/lib/agent/jobs/utils";
import { isImportJobQueueMessage, processImportJob } from "@/lib/import/jobs";
import { processOutboundQueue, type OutboundQueueMessage } from "@/lib/email/send";
import { processWebhookRetry, type WebhookRetryMessage } from "@/lib/email/webhooks";
import { processMailboxPurge } from "@/lib/mailboxes/delete";
import { isMailboxPurgeMessage } from "@/lib/mailboxes/delete-utils";
import { isInboundQueueMessage, isWebhookRetryMessage } from "../worker-utils";
import { createNodeRuntime } from "./runtime/env";
import { applyMigrations } from "./runtime/migrate";
import { startScheduler } from "./runtime/scheduler";
import { startSmtpListener } from "./runtime/smtp";

/**
 * The self-hosted entrypoint: one Node process serving the Next app, the
 * realtime WebSocket, the SMTP listener, the job queues and the backup
 * schedule, the same jobs worker.ts spreads across Cloudflare products.
 */
const logger = createLogger("node-http");

async function main() {
	const port = Number(process.env.PORT ?? 3000);
	const host = process.env.HOST ?? "0.0.0.0";
	const dev = process.env.NODE_ENV !== "production";
	const runtime = createNodeRuntime();
	const { env } = runtime;
	globalThis.__kiteNodeEnv = env;

	const migrated = await applyMigrations(
		runtime.database,
		resolve(process.env.MIGRATIONS_DIR ?? join(process.cwd(), "drizzle", "migrations")),
		{ snapshotDir: join(runtime.dataDir, "backups", "pre-migration") },
	);
	if (migrated.length) console.log(`Applied ${migrated.length} migration(s): ${migrated.join(", ")}`);

	if (!dev && !env.SETUP_TOKEN && !(await hasAdminAccount(env))) {
		const token = randomUUID().replace(/-/g, "");
		(env as { SETUP_TOKEN?: string }).SETUP_TOKEN = token;
		console.log(
			`First-run setup needs a setup token. Open ${env.APP_URL ?? `http://localhost:${port}`}/setup?setup_token=${token} or set SETUP_TOKEN yourself.`,
		);
	}
	const trustProxy = isTrustProxyEnabled(process.env.TRUST_PROXY);

	runtime.inboundQueue.setConsumer(async (body) => {
		if (isInboundQueueMessage(body)) await processInboundMessage(env, body);
	});
	runtime.outboundQueue.setConsumer(async (body) => {
		if (isWebhookRetryMessage(body)) await processWebhookRetry(env, body as WebhookRetryMessage);
		else if (isMailboxPurgeMessage(body)) await processMailboxPurge(env, body);
		else await processOutboundQueue(env, body as OutboundQueueMessage);
	});
	runtime.agentQueue.setConsumer(async (body) => {
		if (
			typeof body === "object" &&
			body !== null &&
			(body as { kind?: unknown }).kind === "agent.draft" &&
			typeof (body as { jobId?: unknown }).jobId === "string"
		)
			await processAgentDraftJob(env, (body as { jobId: string }).jobId);
		else if (isImportJobQueueMessage(body)) await processImportJob(env, body.jobId);
	});

	const app = next({ dev, dir: process.cwd(), hostname: host, port });
	const handle = app.getRequestHandler();
	await app.prepare();

	const server = createServer((request, response) => {
		if ((request.url ?? "").startsWith("/api/")) {
			const trace = createTraceContext(headerValue(request, "traceparent"));
			request.headers.traceparent = trace.traceparent;
			response.setHeader("traceparent", trace.traceparent);
			const started = performance.now();
			response.once("finish", () =>
				logRequestCompleted(logger, {
					traceId: trace.traceId,
					spanId: trace.spanId,
					status: response.statusCode,
					durationMs: Math.round(performance.now() - started),
				}),
			);
		}
		const clientIp = resolveClientIp({
			trustProxy,
			socketAddress: request.socket.remoteAddress,
			cfConnectingIp: headerValue(request, "cf-connecting-ip"),
			forwardedFor: headerValue(request, "x-forwarded-for"),
		});
		// Application code reads these headers for rate limits and audit logs.
		request.headers["cf-connecting-ip"] = clientIp;
		request.headers["x-forwarded-for"] = clientIp;
		delete request.headers["x-real-ip"];

		const url = parse(request.url ?? "/", true);
		if (
			requiresCsrfCheck(request.method ?? "GET", url.pathname ?? "/") &&
			!isBrowserRequestAllowed(request, env.APP_URL)
		) {
			response.writeHead(403, { "Content-Type": "application/json" });
			response.end(JSON.stringify({ error: "Cross-site request blocked" }));
			return;
		}
		if (isDocumentPath(url.pathname ?? "/")) {
			// Next reads the nonce from the request's CSP header; the root layout reads x-nonce.
			const nonce = dev ? undefined : createCspNonce();
			const policy = buildContentSecurityPolicy({ nonce, dev });
			request.headers["content-security-policy"] = policy;
			if (nonce) request.headers["x-nonce"] = nonce;
			else delete request.headers["x-nonce"];
			response.setHeader("Content-Security-Policy", policy);
		}
		void handle(request, response, url);
	});

	const wss = new WebSocketServer({ noServer: true });
	server.on("upgrade", (request, socket, head) => {
		const { pathname } = parse(request.url ?? "/");
		if (pathname !== "/api/realtime") {
			// Next's own dev-mode HMR socket, or anything else, is not ours.
			if (dev) app.getUpgradeHandler()(request, socket, head);
			else socket.destroy();
			return;
		}
		if (!isBrowserRequestAllowed(request, env.APP_URL, true)) {
			socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
			socket.destroy();
			return;
		}
		const cookie = request.headers.cookie ?? "";
		const token = getSessionTokenFromRequest(new Request("http://localhost/", { headers: { cookie } }));
		void getUserFromSession(env, token).then((user) => {
			if (!user || user.disabled) {
				socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
				socket.destroy();
				return;
			}
			wss.handleUpgrade(request, socket, head, (ws) => runtime.realtime.attach(user.id, ws));
		});
	});

	server.listen(port, host, () => {
		console.log(`Kite listening on http://${host}:${port} (data in ${runtime.dataDir})`);
	});

	const smtpPort = Number(process.env.SMTP_INBOUND_PORT ?? 25);
	if (smtpPort > 0) {
		startSmtpListener(env, runtime.mailer, {
			port: smtpPort,
			host: process.env.SMTP_INBOUND_HOST,
			maxSize: Number(process.env.SMTP_MAX_SIZE ?? 36 * 1024 * 1024),
			hostname: process.env.MAIL_HOSTNAME,
			tls:
				process.env.SMTP_TLS_KEY && process.env.SMTP_TLS_CERT
					? { keyPath: process.env.SMTP_TLS_KEY, certPath: process.env.SMTP_TLS_CERT }
					: null,
		});
	}
	const stopScheduler = startScheduler(env);

	const shutdown = () => {
		stopScheduler();
		runtime.inboundQueue.stop();
		runtime.outboundQueue.stop();
		runtime.agentQueue.stop();
		server.close(() => process.exit(0));
		setTimeout(() => process.exit(0), 5000).unref();
	};
	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);
}

function headerValue(request: IncomingMessage, name: string): string | null {
	const value = request.headers[name];
	return Array.isArray(value) ? value.join(", ") : (value ?? null);
}

/** Same-origin check for mutations and the realtime socket, whose cookie a cross-site page could otherwise ride. */
function isBrowserRequestAllowed(
	request: IncomingMessage,
	appUrl: string | undefined,
	ignoreAuthorization = false,
): boolean {
	return isAllowedMutationRequest({
		authorization: ignoreAuthorization ? null : headerValue(request, "authorization"),
		fetchSite: headerValue(request, "sec-fetch-site"),
		origin: headerValue(request, "origin"),
		allowedHosts: getAllowedMutationHosts(headerValue(request, "host"), appUrl),
	});
}

main().catch((error) => {
	console.error("Kite failed to start", error);
	process.exit(1);
});
