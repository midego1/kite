import type { AwsCredentials } from "@/lib/aws/aws-types";

const encoder = new TextEncoder();

function hex(buffer: ArrayBuffer): string {
	return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(data: string | ArrayBuffer | Uint8Array): Promise<string> {
	const bytes = typeof data === "string" ? encoder.encode(data) : data;
	return hex(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
}

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
	const imported = await crypto.subtle.importKey("raw", key as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, [
		"sign",
	]);
	return crypto.subtle.sign("HMAC", imported, encoder.encode(data));
}

const rfc3986 = (value: string) =>
	encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

/** The payload hash for a body that is not hashed: streamed bodies and presigned browser uploads. */
export const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";

/** The longest a presigned URL may live by SigV4's own rule (7 days); callers keep theirs far shorter. */
const MAX_PRESIGN_SECONDS = 7 * 24 * 60 * 60;

export type SignInput = {
	method: string;
	url: URL;
	headers: Record<string, string>;
	/** Hashed into the signature; ignored when `payloadHash` is given. */
	body?: string | ArrayBuffer | Uint8Array;
	/** A precomputed hex digest, or `UNSIGNED-PAYLOAD` for a body that is streamed. */
	payloadHash?: string;
	region: string;
	service: string;
	credentials: AwsCredentials;
	now?: Date;
};

const amzDateOf = (now: Date) => now.toISOString().replace(/[:-]|\.\d{3}/g, "");

const byName = <T extends readonly [string, string]>(left: T, right: T) =>
	left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : left[1] < right[1] ? -1 : left[1] > right[1] ? 1 : 0;

/**
 * Query parameters encoded and sorted the way SigV4 signs them, which is also how they must be sent.
 * @public Exercised by the unit tests.
 */
export function canonicalQueryString(params: Iterable<readonly [string, string]>): string {
	return [...params]
		.map(([name, value]) => [rfc3986(name), rfc3986(value)] as const)
		.sort(byName)
		.map(([name, value]) => `${name}=${value}`)
		.join("&");
}

function canonicalPathOf(url: URL, service: string): string {
	// S3 signs the path as sent; every other service signs it percent-encoded twice.
	if (service === "s3") return url.pathname || "/";
	return (url.pathname || "/")
		.split("/")
		.map((segment) => rfc3986(decodeURIComponent(segment)))
		.join("/");
}

function canonicalHeadersOf(headers: Record<string, string>) {
	const normalized = Object.entries(headers)
		.map(([name, value]) => [name.toLowerCase(), value.trim().replace(/\s+/g, " ")] as const)
		.sort(byName);
	return {
		signedHeaders: normalized.map(([name]) => name).join(";"),
		canonicalHeaders: normalized.map(([name, value]) => `${name}:${value}\n`).join(""),
	};
}

async function signature(
	credentials: AwsCredentials,
	amzDate: string,
	scope: string,
	region: string,
	service: string,
	canonicalRequest: string,
): Promise<string> {
	const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256Hex(canonicalRequest)].join("\n");
	const kDate = await hmac(encoder.encode(`AWS4${credentials.secretAccessKey}`), amzDate.slice(0, 8));
	const kRegion = await hmac(kDate, region);
	const kService = await hmac(kRegion, service);
	const kSigning = await hmac(kService, "aws4_request");
	return hex(await hmac(kSigning, stringToSign));
}

/**
 * AWS Signature Version 4. Returns the headers to send, including Authorization.
 * Web Crypto only, so it runs on Workers and in the Node build alike.
 */
export async function signAwsRequest(input: SignInput): Promise<Record<string, string>> {
	const { method, url, region, service, credentials } = input;
	const amzDate = amzDateOf(input.now ?? new Date());
	const payloadHash = input.payloadHash ?? (await sha256Hex(input.body ?? ""));

	const headers: Record<string, string> = { ...input.headers, host: url.host, "x-amz-date": amzDate };
	if (service === "s3") headers["x-amz-content-sha256"] = payloadHash;
	if (credentials.sessionToken) headers["x-amz-security-token"] = credentials.sessionToken;

	const { signedHeaders, canonicalHeaders } = canonicalHeadersOf(headers);
	const canonicalRequest = [
		method,
		canonicalPathOf(url, service),
		canonicalQueryString(url.searchParams.entries()),
		canonicalHeaders,
		signedHeaders,
		payloadHash,
	].join("\n");
	const scope = `${amzDate.slice(0, 8)}/${region}/${service}/aws4_request`;
	const signed = await signature(credentials, amzDate, scope, region, service, canonicalRequest);

	return {
		...headers,
		Authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signed}`,
	};
}

export type PresignInput = {
	method: string;
	/** The object URL; its own query parameters (uploadId, response-content-*) are signed too. */
	url: URL;
	region: string;
	service: string;
	credentials: AwsCredentials;
	expiresIn: number;
	/** Headers besides `host` the client must send unchanged, for example `content-length`. */
	headers?: Record<string, string>;
	now?: Date;
};

/**
 * A query-string-authenticated URL (SigV4 presigning) with an unsigned payload, for a browser to use
 * without credentials. Any header in `headers` is signed, so the store rejects a request that changes it.
 */
export async function presignAwsUrl(input: PresignInput): Promise<string> {
	const { method, url, region, service, credentials } = input;
	if (!Number.isInteger(input.expiresIn) || input.expiresIn < 1 || input.expiresIn > MAX_PRESIGN_SECONDS)
		throw new Error("Presigned URLs must expire within 7 days");
	const amzDate = amzDateOf(input.now ?? new Date());
	const scope = `${amzDate.slice(0, 8)}/${region}/${service}/aws4_request`;
	const { signedHeaders, canonicalHeaders } = canonicalHeadersOf({ ...input.headers, host: url.host });
	const params: [string, string][] = [
		...url.searchParams.entries(),
		["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
		["X-Amz-Credential", `${credentials.accessKeyId}/${scope}`],
		["X-Amz-Date", amzDate],
		["X-Amz-Expires", String(input.expiresIn)],
		["X-Amz-SignedHeaders", signedHeaders],
	];
	if (credentials.sessionToken) params.push(["X-Amz-Security-Token", credentials.sessionToken]);
	const query = canonicalQueryString(params);
	const canonicalRequest = [
		method,
		canonicalPathOf(url, service),
		query,
		canonicalHeaders,
		signedHeaders,
		UNSIGNED_PAYLOAD,
	].join("\n");
	const signed = await signature(credentials, amzDate, scope, region, service, canonicalRequest);
	return `${url.origin}${url.pathname}?${query}&X-Amz-Signature=${signed}`;
}
