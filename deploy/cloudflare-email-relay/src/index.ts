import { createTraceContext } from "../../../src/lib/trace.mjs";
import { createLogger } from "../../../src/lib/logger.mjs";
import { recordMetric } from "../../../src/lib/metrics.mjs";
import { signInbound, signInboundHeaders } from "../../../src/lib/email/inbound-signature.mjs";

const logger = createLogger("email-relay");

/**
 * Kite email relay. Keeps MX on Cloudflare Email Routing while the app
 * runs elsewhere: every message routed to this Worker is posted to the
 * self-hosted server, which answers with the routing decision so reject and
 * forward still happen here, on the live message.
 *
 * Route the domain's catch-all (and any address rules) to this Worker.
 */
type Env = {
	KITE_URL?: string;
	/** Relays deployed before the rename to Kite have their server URL stored under this name. */
	MAILFLARE_URL?: string;
	INBOUND_WEBHOOK_SECRET: string;
	METRICS?: AnalyticsEngineDataset;
};

type RelayOutcome =
	"too_large" | "upstream_too_large" | "upstream_error" | "reject" | "store" | "forward" | "forward_failed";

type Decision =
	| { action: "reject"; reason: string }
	| { action: "forward"; forwardTo: string | null; forwardHeaders?: Record<string, string> }
	| { action: "store"; forwardTo: string | null; forwardHeaders?: Record<string, string> };

export default {
	async fetch(request: Request) {
		if (request.method !== "GET" || new URL(request.url).pathname !== "/health")
			return new Response("Not found", { status: 404 });
		return Response.json({ status: "ok", service: "kite-email-relay" }, { headers: { "Cache-Control": "no-store" } });
	},
	async email(message: ForwardableEmailMessage, env: Env) {
		const started = performance.now();
		const record = (outcome: RelayOutcome, status = 0) =>
			recordMetric(env.METRICS, {
				event: "relay",
				service: "kite-email-relay",
				outcome,
				status,
				durationMs: Math.round(performance.now() - started),
			});
		if (message.rawSize > 25 * 1024 * 1024) {
			record("too_large");
			message.setReject(
				"Message rejected: raw email exceeds the 25 MiB receiving limit. Send a download link instead.",
			);
			return;
		}
		const trace = createTraceContext();
		const raw = await new Response(message.raw).arrayBuffer();
		// Carries Cloudflare's Authentication-Results, so the server trusts it only with its own signature.
		const headers = JSON.stringify(Object.fromEntries(message.headers));
		let decision: Decision;
		try {
			const serverUrl = env.KITE_URL ?? env.MAILFLARE_URL;
			if (!serverUrl) throw new Error("KITE_URL is not set");
			const response = await fetch(`${serverUrl.replace(/\/$/, "")}/api/inbound`, {
				method: "POST",
				signal: AbortSignal.timeout(15_000),
				headers: {
					"Content-Type": "message/rfc822",
					traceparent: trace.traceparent,
					"X-Kite-From": message.from,
					"X-Kite-To": message.to,
					"X-Kite-Headers": headers,
					"X-Kite-Signature": await signInbound(env.INBOUND_WEBHOOK_SECRET, raw, message.from, message.to),
					"X-Kite-Headers-Signature": await signInboundHeaders(
						env.INBOUND_WEBHOOK_SECRET,
						raw,
						message.from,
						message.to,
						headers,
					),
				},
				body: raw,
			});
			if (response.status === 413) {
				record("upstream_too_large", 413);
				message.setReject(
					"Message rejected: receiving server says the email is too large. Send a download link instead.",
				);
				return;
			}
			if (!response.ok) throw new Error(`Kite answered ${response.status}`);
			decision = (await response.json()) as Decision;
			logger.info("relay.request_completed", {
				traceId: trace.traceId,
				spanId: trace.spanId,
				status: response.status,
				durationMs: Math.round(performance.now() - started),
			});
		} catch (error) {
			logger.error("relay.request_failed", {
				traceId: trace.traceId,
				spanId: trace.spanId,
				durationMs: Math.round(performance.now() - started),
				error,
			});
			record("upstream_error");
			// A rejection with a temporary-sounding reason makes most senders retry later.
			message.setReject("Kite is temporarily unavailable, please retry");
			return;
		}

		if (decision.action === "reject") {
			record("reject", 200);
			message.setReject(decision.reason);
			return;
		}
		if (decision.forwardTo) {
			try {
				await message.forward(decision.forwardTo, new Headers(decision.forwardHeaders ?? {}));
				record("forward", 200);
			} catch (error) {
				record("forward_failed", 200);
				logger.error("relay.forward_failed", { traceId: trace.traceId, spanId: trace.spanId, error });
			}
			return;
		}
		record("store", 200);
	},
} satisfies ExportedHandler<Env>;
