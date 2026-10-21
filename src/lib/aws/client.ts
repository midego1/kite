import { signAwsRequest, UNSIGNED_PAYLOAD } from "@/lib/aws/sigv4";
import { xmlTag } from "@/lib/aws/xml";
import type { AwsConfig } from "@/lib/aws/aws-types";

export class AwsError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly code: string,
	) {
		super(message);
	}

	get accessDenied(): boolean {
		return (
			/AccessDenied|UnauthorizedOperation|AuthorizationError|NotAuthorized|Forbidden/i.test(this.code) ||
			this.status === 403
		);
	}
}

async function parseError(response: Response): Promise<AwsError> {
	const text = await response.text().catch(() => "");
	let code = response.headers.get("x-amzn-errortype")?.split(":")[0] ?? "";
	let message = "";
	try {
		const json = JSON.parse(text) as { __type?: string; message?: string; Message?: string };
		code ||= json.__type?.split("#").pop() ?? "";
		message = json.message ?? json.Message ?? "";
	} catch {
		code ||= xmlTag(text, "Code") ?? "";
		message = xmlTag(text, "Message") ?? "";
	}
	return new AwsError(
		message || `AWS request failed (${response.status})`,
		response.status,
		code || `HTTP${response.status}`,
	);
}

export type AwsRequest = {
	config: AwsConfig;
	service: string;
	/** Defaults to `${service}.${region}.amazonaws.com`. May carry a port (`localhost:9000`). */
	host?: string;
	/** `http` only for S3-compatible stores a dev flag allowed (src/lib/storage/endpoint.ts). */
	scheme?: "https" | "http";
	method?: string;
	path?: string;
	query?: Record<string, string>;
	/** A stream is sent unhashed (`UNSIGNED-PAYLOAD`) and needs `contentLength`. */
	body?: string | ArrayBuffer | Uint8Array | ReadableStream<Uint8Array>;
	/** The exact byte length of a streamed body. */
	contentLength?: number;
	/** Sign the body as `UNSIGNED-PAYLOAD` even when it is in memory, which spares hashing large objects. */
	unsignedPayload?: boolean;
	headers?: Record<string, string>;
	/** Region used to sign; defaults to the config's. */
	region?: string;
	/** Statuses answered without throwing (a HEAD probe's 404). */
	allowStatuses?: number[];
	fetch?: typeof fetch;
};

type FixedLengthStreamConstructor = new (length: number) => TransformStream<Uint8Array, Uint8Array>;

/**
 * A streamed body the runtime sends with a Content-Length, which S3 requires (it refuses chunked uploads that
 * are not aws-chunked). Workers learn the length from a FixedLengthStream; Node's fetch sends the header as given.
 */
function streamedBody(body: ReadableStream<Uint8Array>, length: number): ReadableStream<Uint8Array> {
	const FixedLength = (globalThis as { FixedLengthStream?: FixedLengthStreamConstructor }).FixedLengthStream;
	if (!FixedLength) return body;
	const { readable, writable } = new FixedLength(length);
	void body.pipeTo(writable).catch(() => undefined);
	return readable;
}

function requestUrl(request: AwsRequest, region: string): URL {
	const host = request.host ?? `${request.service}.${region}.amazonaws.com`;
	const url = new URL(`${request.scheme ?? "https"}://${host}${request.path ?? "/"}`);
	for (const [name, value] of Object.entries(request.query ?? {})) url.searchParams.set(name, value);
	return url;
}

/** What to sign and send for the body: streams go unhashed with their exact length. */
function requestBody(
	request: AwsRequest,
	method: string,
): {
	sign: { payloadHash: string } | { body: string | ArrayBuffer | Uint8Array };
	headers: Record<string, string>;
	init: { body: BodyInit | undefined; duplex?: "half" };
} {
	const body = request.body ?? "";
	const sendsBody = method !== "GET" && method !== "HEAD";
	if (!(body instanceof ReadableStream))
		return {
			sign: request.unsignedPayload ? { payloadHash: UNSIGNED_PAYLOAD } : { body },
			headers: {},
			init: { body: sendsBody ? (body as BodyInit) : undefined },
		};
	const length = request.contentLength;
	if (length === undefined || !Number.isSafeInteger(length) || length < 0)
		throw new Error("A streamed body needs its exact length");
	return {
		sign: { payloadHash: UNSIGNED_PAYLOAD },
		headers: { "content-length": String(length) },
		init: sendsBody ? { body: streamedBody(body, length), duplex: "half" as const } : { body: undefined },
	};
}

export async function awsRequest(request: AwsRequest): Promise<Response> {
	const { config, service } = request;
	const region = request.region ?? config.region;
	const url = requestUrl(request, region);
	const method = request.method ?? "GET";
	const body = requestBody(request, method);
	const headers = await signAwsRequest({
		method,
		url,
		headers: { ...request.headers, ...body.headers },
		...body.sign,
		region,
		service,
		credentials: config,
	});
	const init: RequestInit & { duplex?: "half" } = { method, headers, ...body.init };
	const response = await (request.fetch ?? fetch)(url, init);
	if (!response.ok && !request.allowStatuses?.includes(response.status)) throw await parseError(response);
	return response;
}

/** AWS JSON REST (SES v2). */
export async function awsJson<T>(request: AwsRequest & { json?: unknown }): Promise<T> {
	const response = await awsRequest({
		...request,
		body: request.json === undefined ? request.body : JSON.stringify(request.json),
		headers: { "Content-Type": "application/json", ...request.headers },
	});
	const text = await response.text();
	return (text ? JSON.parse(text) : {}) as T;
}

/** AWS Query protocol (STS, SNS, SES v1): form-encoded POST, XML back. */
export async function awsQuery(
	config: AwsConfig,
	service: string,
	version: string,
	action: string,
	params: Record<string, string> = {},
	options: { host?: string; signingService?: string } = {},
): Promise<string> {
	const body = new URLSearchParams({ Action: action, Version: version, ...params }).toString();
	const response = await awsRequest({
		config,
		service: options.signingService ?? service,
		host: options.host ?? `${service}.${config.region}.amazonaws.com`,
		method: "POST",
		body,
		headers: { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" },
	});
	return response.text();
}
