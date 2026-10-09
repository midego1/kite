import type { Logger } from "./logger.mjs";
export type TraceContext = { traceId: string; spanId: string; traceparent: string };
export function createTraceContext(incoming?: string | null): TraceContext;
export function logRequestCompleted(
	logger: Logger,
	fields: { traceId: string; spanId: string; status: number; durationMs: number },
): void;
export function traceHttp(
	request: Request,
	handle: (request: Request) => Promise<Response>,
	logger: Logger,
	onComplete?: (result: { status: number; durationMs: number; failed: boolean }) => void,
): Promise<Response>;
