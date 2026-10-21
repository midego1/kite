import { xmlBlocks, xmlTag } from "@/lib/aws/xml";
import type { S3Location } from "./types";

const META_PREFIX = "x-amz-meta-";
/**
 * S3 lowercases metadata header names, while Kite's keys are camelCase (`userId`, `messageId`), so the
 * original names travel in one extra header and are restored on read.
 */
const KEYS_HEADER = `${META_PREFIX}kite-keys`;
const META_NAME = /^[A-Za-z0-9_-]+$/;

const rfc3986 = (value: string) =>
	encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

/** The request path of an object key, each segment percent-encoded as S3 signs it. */
export function encodeKeyPath(key: string): string {
	return `/${key.split("/").map(rfc3986).join("/")}`;
}

export function bucketHost(location: Pick<S3Location, "bucket" | "endpoint" | "addressing">): string {
	return location.addressing === "virtual" ? `${location.bucket}.${location.endpoint}` : location.endpoint;
}

/** The path of the bucket itself (`?cors`, `?uploads`, ListObjectsV2). */
export function bucketPath(location: Pick<S3Location, "bucket" | "addressing">): string {
	return location.addressing === "virtual" ? "/" : `/${rfc3986(location.bucket)}`;
}

export function objectPath(location: Pick<S3Location, "bucket" | "addressing">, key: string): string {
	return location.addressing === "virtual" ? encodeKeyPath(key) : `/${rfc3986(location.bucket)}${encodeKeyPath(key)}`;
}

/** The origin browsers send presigned requests to, listed exactly in the CSP. */
export function storeOrigin(location: S3Location): string {
	return `${location.scheme}://${bucketHost(location)}`;
}

/** Header values must be ASCII; anything else is percent-encoded rather than rejected by fetch. */
function asciiHeader(value: string): string {
	return value.replace(/[^\x20-\x7e]/g, (char) => encodeURIComponent(char)).replace(/[\r\n]/g, " ");
}

export type HttpMetadata = { contentType?: string; contentDisposition?: string; cacheControl?: string };

export function toHttpMetadata(value: HttpMetadata | Headers | undefined): HttpMetadata {
	if (!value) return {};
	if (value instanceof Headers)
		return {
			contentType: value.get("content-type") ?? undefined,
			contentDisposition: value.get("content-disposition") ?? undefined,
			cacheControl: value.get("cache-control") ?? undefined,
		};
	return value;
}

/** Request headers for an object's HTTP and custom metadata; custom values are percent-encoded (S3 headers are ASCII). */
export function metadataHeaders(
	httpMetadata: HttpMetadata | Headers | undefined,
	customMetadata: Record<string, string> | undefined,
): Record<string, string> {
	const http = toHttpMetadata(httpMetadata);
	const headers: Record<string, string> = {};
	if (http.contentType) headers["Content-Type"] = asciiHeader(http.contentType);
	if (http.contentDisposition) headers["Content-Disposition"] = asciiHeader(http.contentDisposition);
	if (http.cacheControl) headers["Cache-Control"] = asciiHeader(http.cacheControl);
	const names: string[] = [];
	for (const [name, value] of Object.entries(customMetadata ?? {})) {
		if (!META_NAME.test(name) || name.toLowerCase() === "kite-keys") throw new Error(`Invalid metadata name ${name}`);
		headers[`${META_PREFIX}${name.toLowerCase()}`] = encodeURIComponent(value);
		if (name !== name.toLowerCase()) names.push(name);
	}
	if (names.length) headers[KEYS_HEADER] = names.join(",");
	return headers;
}

function decodeValue(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

export function readMetadata(headers: Headers): {
	httpMetadata: HttpMetadata;
	customMetadata: Record<string, string>;
} {
	const original = new Map(
		(headers.get(KEYS_HEADER) ?? "")
			.split(",")
			.filter(Boolean)
			.map((name) => [name.toLowerCase(), name] as const),
	);
	const customMetadata: Record<string, string> = {};
	headers.forEach((value, name) => {
		if (!name.startsWith(META_PREFIX) || name === KEYS_HEADER) return;
		const key = name.slice(META_PREFIX.length);
		customMetadata[original.get(key) ?? key] = decodeValue(value);
	});
	return {
		httpMetadata: {
			contentType: headers.get("content-type") ?? undefined,
			contentDisposition: headers.get("content-disposition") ?? undefined,
			cacheControl: headers.get("cache-control") ?? undefined,
		},
		customMetadata,
	};
}

export type RangeRequest = { offset?: number; length?: number; suffix?: number };

export function rangeHeader(range: RangeRequest | undefined): string | null {
	if (!range) return null;
	if (range.suffix != null) return `bytes=-${range.suffix}`;
	const start = range.offset ?? 0;
	return range.length != null ? `bytes=${start}-${start + range.length - 1}` : `bytes=${start}-`;
}

/** The whole object's size: from Content-Range on a ranged response, otherwise Content-Length. */
export function objectSize(headers: Headers): number {
	const total = /\/(\d+)$/.exec(headers.get("content-range") ?? "")?.[1];
	return Number(total ?? headers.get("content-length") ?? 0);
}

/** The served byte range of a 206 response, in R2's shape. */
export function servedRange(headers: Headers): { offset: number; length: number } | undefined {
	const match = /^bytes (\d+)-(\d+)\//.exec(headers.get("content-range") ?? "");
	if (!match) return undefined;
	return { offset: Number(match[1]), length: Number(match[2]) - Number(match[1]) + 1 };
}

export const stripQuotes = (etag: string | null | undefined) => (etag ?? "").replace(/"/g, "");

const escapeXml = (value: string) =>
	value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function completeMultipartXml(parts: { partNumber: number; etag: string }[]): string {
	const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
	return `<CompleteMultipartUpload>${sorted
		.map(
			(part) =>
				`<Part><PartNumber>${part.partNumber}</PartNumber><ETag>"${escapeXml(stripQuotes(part.etag))}"</ETag></Part>`,
		)
		.join("")}</CompleteMultipartUpload>`;
}

/** B2 and AWS can answer CompleteMultipartUpload and CopyObject with `200` and an `<Error>` document. */
export function errorInBody(text: string): { code: string; message: string } | null {
	if (!/<Error[\s>]/.test(text)) return null;
	return { code: xmlTag(text, "Code") ?? "InternalError", message: xmlTag(text, "Message") ?? "The store failed" };
}

export type ListedObject = { key: string; size: number; etag: string; uploaded: Date };

export function parseListObjects(xml: string): { objects: ListedObject[]; truncated: boolean; cursor?: string } {
	const objects = xmlBlocks(xml, "Contents").map((block) => ({
		key: xmlTag(block, "Key") ?? "",
		size: Number(xmlTag(block, "Size") ?? 0),
		etag: stripQuotes(xmlTag(block, "ETag")),
		uploaded: new Date(xmlTag(block, "LastModified") ?? 0),
	}));
	const truncated = xmlTag(xml, "IsTruncated") === "true";
	const cursor = truncated ? (xmlTag(xml, "NextContinuationToken") ?? undefined) : undefined;
	return { objects, truncated: truncated && !!cursor, cursor };
}

export function parseListParts(xml: string): { partNumber: number; etag: string; size: number }[] {
	return xmlBlocks(xml, "Part").map((block) => ({
		partNumber: Number(xmlTag(block, "PartNumber") ?? 0),
		etag: stripQuotes(xmlTag(block, "ETag")),
		size: Number(xmlTag(block, "Size") ?? 0),
	}));
}

/**
 * The CORS rule direct uploads need: the app origin may PUT with a Content-Type and read the ETag of each
 * part. GET is included so the validation's presigned read works from the browser too.
 */
export function corsRuleXml(origins: string[]): string {
	const allowed = origins.map((origin) => `<AllowedOrigin>${escapeXml(origin)}</AllowedOrigin>`).join("");
	return `<CORSConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><CORSRule><ID>kite-direct-uploads</ID>${allowed}<AllowedMethod>PUT</AllowedMethod><AllowedMethod>GET</AllowedMethod><AllowedMethod>HEAD</AllowedMethod><AllowedHeader>content-type</AllowedHeader><ExposeHeader>ETag</ExposeHeader><MaxAgeSeconds>3600</MaxAgeSeconds></CORSRule></CORSConfiguration>`;
}

/** The same rule as JSON, for providers whose CORS is set in a console or CLI (B2, Hetzner, others). */
export function corsRuleJson(origins: string[]): string {
	return JSON.stringify(
		[
			{
				AllowedOrigins: origins,
				AllowedMethods: ["PUT", "GET", "HEAD"],
				AllowedHeaders: ["content-type"],
				ExposeHeaders: ["ETag"],
				MaxAgeSeconds: 3600,
			},
		],
		null,
		2,
	);
}

export function abortIncompleteLifecycleXml(days: number): string {
	return `<LifecycleConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Rule><ID>kite-abort-incomplete-uploads</ID><Filter><Prefix></Prefix></Filter><Status>Enabled</Status><AbortIncompleteMultipartUpload><DaysAfterInitiation>${days}</DaysAfterInitiation></AbortIncompleteMultipartUpload></Rule></LifecycleConfiguration>`;
}
