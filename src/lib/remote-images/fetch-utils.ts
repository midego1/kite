import { isBlockedHost, isIpAddressLiteral } from "@/lib/security/outbound-url";
import type { RemoteImageFetch, RemoteImageFetchOptions, RemoteImageResult, RemoteImageUrlPolicy } from "./fetch-types";

const REMOTE_IMAGE_MAX_URL_LENGTH = 4096;
const REMOTE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const REMOTE_IMAGE_MAX_REDIRECTS = 3;
const REMOTE_IMAGE_TIMEOUT_MS = 10_000;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
// Raster formats only: SVG and anything else that can carry script or markup is refused.
const ALLOWED_CONTENT_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);
const ACCEPT = [...ALLOWED_CONTENT_TYPES].join(",");
const USER_AGENT = "Kite-Remote-Images/1.0";
// Reserved for testing and documentation (RFC 2606, RFC 6761) or not on the public internet.
const RESERVED_SUFFIXES = [".test", ".example", ".invalid", ".onion", ".arpa"];
const LOOPBACK_HOST = "127.0.0.1";

export class RemoteImageError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly code: string,
	) {
		super(message);
		this.name = "RemoteImageError";
	}
}

/** Dev/test only: the e2e image server on 127.0.0.1 is never reachable in production. */
export function isRemoteImageLoopbackAllowed(flag: string | undefined, nodeEnv: string | undefined): boolean {
	return flag === "1" && nodeEnv !== "production";
}

function invalidUrl(message = "Invalid remote image URL"): never {
	throw new RemoteImageError(message, 400, "invalid_url");
}

function isReservedHost(hostname: string): boolean {
	const host = hostname.toLowerCase().replace(/\.$/, "");
	return RESERVED_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

function parseOrigin(origin: string): URL | null {
	try {
		return new URL(origin);
	} catch {
		return null;
	}
}

/**
 * The URL the proxy fetches for `value`, or a 400 `RemoteImageError`. http is upgraded to
 * https, as the reader's `upgrade-insecure-requests` would; credentials, ports, IP literals,
 * local and reserved names and this install's own host are refused.
 */
export function parseRemoteImageUrl(value: string, policy: RemoteImageUrlPolicy): URL {
	if (!value || value.length > REMOTE_IMAGE_MAX_URL_LENGTH) invalidUrl();
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		invalidUrl();
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") invalidUrl();
	if (url.username || url.password) invalidUrl("Remote image URLs with credentials are not allowed");
	const app = parseOrigin(policy.appOrigin);
	if (policy.allowLoopback && url.hostname === LOOPBACK_HOST && url.port !== app?.port) return url;
	if (url.port) invalidUrl("Remote image URLs must use the default port");
	if (isIpAddressLiteral(url.hostname) || isBlockedHost(url.hostname) || isReservedHost(url.hostname))
		invalidUrl("Private, local and reserved addresses are not allowed");
	if (url.hostname.toLowerCase() === app?.hostname.toLowerCase())
		invalidUrl("Remote image URL cannot target this application");
	if (url.protocol === "http:") url.protocol = "https:";
	return url;
}

function contentTypeEssence(value: string | null): string | null {
	const essence = value?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
	return ALLOWED_CONTENT_TYPES.has(essence) ? essence : null;
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
	return String.fromCharCode(...bytes.subarray(start, start + length));
}

function hasAvifSignature(bytes: Uint8Array): boolean {
	if (bytes.length < 16 || ascii(bytes, 4, 4) !== "ftyp") return false;
	const boxSize = Math.min(bytes.length, new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0));
	for (let offset = 8; offset + 4 <= boxSize; offset += 4) {
		const brand = ascii(bytes, offset, 4);
		if (brand === "avif" || brand === "avis") return true;
	}
	return false;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** The bytes must be the declared format, so an HTML or SVG body labelled image/png is refused. */
function imageSignatureMatches(contentType: string, bytes: Uint8Array): boolean {
	switch (contentType) {
		case "image/png":
			return bytes.length >= 8 && PNG_SIGNATURE.every((value, index) => bytes[index] === value);
		case "image/jpeg":
			return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
		case "image/gif":
			return bytes.length >= 6 && /^GIF8[79]a$/.test(ascii(bytes, 0, 6));
		case "image/webp":
			return bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP";
		case "image/avif":
			return hasAvifSignature(bytes);
		default:
			return false;
	}
}

function tooLarge(): RemoteImageError {
	return new RemoteImageError("Remote image is too large", 413, "too_large");
}

async function readLimitedBody(response: Response, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
	const declared = Number(response.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > maxBytes) {
		await response.body?.cancel().catch(() => undefined);
		throw tooLarge();
	}
	if (!response.body) throw new RemoteImageError("Remote image has no body", 502, "empty_body");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > maxBytes) throw tooLarge();
			chunks.push(value);
		}
	} catch (error) {
		await reader.cancel().catch(() => undefined);
		throw error;
	}
	const body = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return body;
}

async function discard(response: Response): Promise<void> {
	await response.body?.cancel().catch(() => undefined);
}

function nextHop(response: Response, current: URL, policy: RemoteImageUrlPolicy): URL {
	const location = response.headers.get("location");
	if (!location) throw new RemoteImageError("Remote image redirect has no location", 502, "invalid_redirect");
	let target: URL;
	try {
		target = new URL(location, current);
	} catch {
		throw new RemoteImageError("Remote image redirect is invalid", 502, "invalid_redirect");
	}
	return parseRemoteImageUrl(target.href, policy);
}

async function requestHop(fetchImpl: RemoteImageFetch, url: URL, signal: AbortSignal) {
	try {
		// Only these headers: no cookie, authorization, referrer or client address of the reader.
		return await fetchImpl(url.href, {
			method: "GET",
			headers: { Accept: ACCEPT, "User-Agent": USER_AGENT },
			redirect: "manual",
			signal,
		});
	} catch {
		if (signal.aborted) throw new RemoteImageError("Remote image request timed out", 504, "timeout");
		throw new RemoteImageError("Could not fetch remote image", 502, "upstream_error");
	}
}

async function readImage(response: Response, maxBytes: number, signal: AbortSignal): Promise<RemoteImageResult> {
	if (!response.ok) {
		await discard(response);
		throw new RemoteImageError("Remote image server returned an error", 502, "upstream_status");
	}
	const contentType = contentTypeEssence(response.headers.get("content-type"));
	if (!contentType) {
		await discard(response);
		throw new RemoteImageError("Remote resource is not a supported image", 415, "unsupported_type");
	}
	let body: Uint8Array<ArrayBuffer>;
	try {
		body = await readLimitedBody(response, maxBytes);
	} catch (error) {
		if (signal.aborted && !(error instanceof RemoteImageError))
			throw new RemoteImageError("Remote image request timed out", 504, "timeout");
		throw error;
	}
	if (!imageSignatureMatches(contentType, body))
		throw new RemoteImageError("Remote image signature is invalid", 415, "invalid_signature");
	return { body, contentType };
}

/**
 * Fetches a remote image for the reader's same-origin proxy (`/api/remote-images`). Only the
 * image bytes and a validated type come back, so no header of the image host's response reaches
 * the browser, and the request carries nothing of the reader's. Follows at most `maxRedirects`
 * redirects, checking every hop with the same policy as the first URL, under one timeout for the
 * whole exchange including the body.
 */
export async function fetchRemoteImage(value: string, options: RemoteImageFetchOptions): Promise<RemoteImageResult> {
	const fetchImpl: RemoteImageFetch = options.fetch ?? ((input, init) => fetch(input, init));
	const maxRedirects = options.maxRedirects ?? REMOTE_IMAGE_MAX_REDIRECTS;
	let current = parseRemoteImageUrl(value, options);
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? REMOTE_IMAGE_TIMEOUT_MS);
	try {
		for (let redirects = 0; ; redirects += 1) {
			const response = await requestHop(fetchImpl, current, controller.signal);
			if (!REDIRECT_STATUSES.has(response.status))
				return await readImage(response, options.maxBytes ?? REMOTE_IMAGE_MAX_BYTES, controller.signal);
			await discard(response);
			if (redirects >= maxRedirects)
				throw new RemoteImageError("Too many remote image redirects", 502, "too_many_redirects");
			current = nextHop(response, current, options);
		}
	} finally {
		clearTimeout(timeout);
	}
}
