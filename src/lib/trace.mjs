/** W3C v00 trace context; IDs contain no request, email or credential data. */
function randomHex(bytes) {
	return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (byte) => byte.toString(16).padStart(2, "0")).join(
		"",
	);
}

/** @param {string|null|undefined} [incoming] */
export function createTraceContext(incoming) {
	const match = typeof incoming === "string" ? /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(incoming) : null;
	const valid = match && !/^0+$/.test(match[1]) && !/^0+$/.test(match[2]);
	const traceId = valid ? match[1] : randomHex(16);
	const spanId = randomHex(8);
	const flags = valid ? (parseInt(match[3], 16) & 1).toString(16).padStart(2, "0") : "01";
	return { traceId, spanId, traceparent: `00-${traceId}-${spanId}-${flags}` };
}

/** Requests slower than this are logged even when they succeed. */
const SLOW_REQUEST_MS = 1000;

/**
 * Log a finished request only when it needs attention: server errors, slow
 * responses and client errors. Fast successful requests are not logged, so
 * routine traffic does not flood the log destination.
 * @param {import('./logger.mjs').Logger} logger
 * @param {{traceId: string, spanId: string, status: number, durationMs: number}} fields
 */
export function logRequestCompleted(logger, fields) {
	if (fields.status >= 500) logger.error("http.request_completed", fields);
	else if (fields.durationMs > SLOW_REQUEST_MS) logger.warn("http.request_completed", { ...fields, slow: true });
	else if (fields.status >= 400) logger.info("http.request_completed", fields);
}

/**
 * Record a low-cardinality duration/status event. No URL, cookies or mail content.
 * @param {Request} request
 * @param {(request: Request) => Promise<Response>} handle
 * @param {import('./logger.mjs').Logger} logger
 * @param {(result: {status: number, durationMs: number, failed: boolean}) => void} [onComplete]
 *   Called once per request, also when the handler throws (status 500, failed). Errors it throws are ignored.
 */
export async function traceHttp(request, handle, logger, onComplete) {
	const trace = createTraceContext(request.headers.get("traceparent"));
	const headers = new Headers(request.headers);
	headers.set("traceparent", trace.traceparent);
	const started = performance.now();
	const complete = (status, failed) => {
		try {
			onComplete?.({ status, durationMs: Math.round(performance.now() - started), failed });
		} catch {
			// Reporting must not change the response.
		}
	};
	try {
		const response = await handle(new Request(request, { headers }));
		complete(response.status, false);
		logRequestCompleted(logger, {
			traceId: trace.traceId,
			spanId: trace.spanId,
			status: response.status,
			durationMs: Math.round(performance.now() - started),
		});
		if (response.status === 101) return response;
		const traced = new Response(response.body, response);
		traced.headers.set("traceparent", trace.traceparent);
		return traced;
	} catch (error) {
		complete(500, true);
		logger.error("http.request_failed", {
			traceId: trace.traceId,
			spanId: trace.spanId,
			durationMs: Math.round(performance.now() - started),
			error,
		});
		throw error;
	}
}
