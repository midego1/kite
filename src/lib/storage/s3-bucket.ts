import { AwsError, awsRequest, type AwsRequest } from "@/lib/aws/client";
import { sha256ChecksumHeaders } from "@/lib/aws/s3";
import { presignAwsUrl } from "@/lib/aws/sigv4";
import { xmlTag } from "@/lib/aws/xml";
import { getContentDisposition } from "@/lib/http/content-disposition-utils";
import {
	abortIncompleteLifecycleXml,
	bucketHost,
	bucketPath,
	completeMultipartXml,
	corsRuleXml,
	errorInBody,
	metadataHeaders,
	objectPath,
	objectSize,
	parseLastModified,
	parseListObjects,
	parseListParts,
	rangeHeader,
	readMetadata,
	servedRange,
	storeOrigin,
	stripQuotes,
	type HttpMetadata,
	type RangeRequest,
} from "./s3-utils";
import type { PresignGetOptions, S3Credentials, S3Location, StoreSigner } from "./types";

/**
 * An S3-compatible bucket behind the R2 bucket API the app already uses (get with a range, head, put, delete,
 * list, multipart), so any caller of `env.BUCKET` can be served by AWS S3, B2, Wasabi, Hetzner, MinIO or R2's S3
 * API. Adapted from Mailflare 83ade98 (`b2-bucket.ts`): any endpoint and addressing, streamed bodies with
 * UNSIGNED-PAYLOAD instead of buffering, encoded metadata, list, copy and presigned browser URLs.
 */

/**
 * Bodies of unknown length are buffered up to this size; larger ones must be streamed with a known length.
 * @public Exercised by the unit tests.
 */
export const MAX_BUFFERED_BYTES = 32 * 1024 * 1024;
/** Presigned URLs Kite issues live at most an hour (uploads 15 minutes, downloads 5). */
const MAX_PRESIGN_SECONDS = 3600;

type PutValue = ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob | null;
/** R2's put options, plus the length of a streamed body (the migration job and backups know it). */
export type S3PutOptions = {
	httpMetadata?: HttpMetadata | Headers;
	customMetadata?: Record<string, string>;
	contentLength?: number;
	storageClass?: string;
};
type GetOptions = { range?: RangeRequest | Headers };

const encoder = new TextEncoder();

async function readLimited(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > limit) {
			await reader.cancel().catch(() => undefined);
			throw new Error("A body of unknown length is too large to buffer; send it with its length");
		}
		chunks.push(value);
	}
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

/** The body to send and its length: streams of known length stay streams, anything else is bytes. */
async function prepareBody(
	value: PutValue,
	contentLength: number | undefined,
): Promise<{ body: Uint8Array | ReadableStream<Uint8Array>; length: number }> {
	if (value === null) return { body: new Uint8Array(0), length: 0 };
	if (typeof value === "string") {
		const bytes = encoder.encode(value);
		return { body: bytes, length: bytes.byteLength };
	}
	if (value instanceof ArrayBuffer) return { body: new Uint8Array(value), length: value.byteLength };
	if (ArrayBuffer.isView(value)) {
		const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
		return { body: bytes, length: bytes.byteLength };
	}
	if (value instanceof Blob) {
		if (value.size > MAX_BUFFERED_BYTES)
			return { body: value.stream() as ReadableStream<Uint8Array>, length: value.size };
		const bytes = new Uint8Array(await value.arrayBuffer());
		return { body: bytes, length: bytes.byteLength };
	}
	const stream = value as ReadableStream<Uint8Array>;
	if (contentLength !== undefined && Number.isSafeInteger(contentLength) && contentLength >= 0)
		return { body: stream, length: contentLength };
	const bytes = await readLimited(stream, MAX_BUFFERED_BYTES);
	return { body: bytes, length: bytes.byteLength };
}

const isMissing = (error: unknown) =>
	error instanceof AwsError && (error.status === 404 || error.code === "NoSuchKey" || error.code === "NotFound");

/** Shaped like R2ObjectBody, so callers cannot tell which store served it. */
export class S3Object {
	readonly size: number;
	readonly etag: string;
	readonly uploaded: Date;
	readonly httpMetadata: HttpMetadata;
	readonly customMetadata: Record<string, string>;
	readonly range?: { offset: number; length: number };
	readonly storageClass: string;
	readonly checksums = { toJSON: () => ({}) };

	constructor(
		readonly key: string,
		private readonly response: Response,
		size?: number,
	) {
		const headers = response.headers;
		this.size = size ?? objectSize(headers);
		this.etag = stripQuotes(headers.get("etag"));
		this.uploaded = parseLastModified(headers.get("last-modified"));
		const meta = readMetadata(headers);
		this.httpMetadata = meta.httpMetadata;
		this.customMetadata = meta.customMetadata;
		this.range = servedRange(headers);
		this.storageClass = headers.get("x-amz-storage-class") ?? "STANDARD";
	}

	get httpEtag() {
		return `"${this.etag}"`;
	}
	get version() {
		return this.etag;
	}
	get body(): ReadableStream<Uint8Array> {
		return (this.response.body ?? new Blob([]).stream()) as ReadableStream<Uint8Array>;
	}
	get bodyUsed() {
		return this.response.bodyUsed;
	}
	arrayBuffer() {
		return this.response.arrayBuffer();
	}
	async bytes() {
		return new Uint8Array(await this.response.arrayBuffer());
	}
	text() {
		return this.response.text();
	}
	json<T>() {
		return this.response.json() as Promise<T>;
	}
	blob() {
		return this.response.blob();
	}
	writeHttpMetadata(headers: Headers) {
		if (this.httpMetadata.contentType) headers.set("Content-Type", this.httpMetadata.contentType);
		if (this.httpMetadata.contentDisposition) headers.set("Content-Disposition", this.httpMetadata.contentDisposition);
		if (this.httpMetadata.cacheControl) headers.set("Cache-Control", this.httpMetadata.cacheControl);
	}
}

type RequestInit = Omit<AwsRequest, "config" | "service" | "host" | "scheme" | "path" | "fetch">;

export type S3BucketOptions = {
	fetch?: typeof fetch;
	/** Opens the credentials on first use, so a configured store costs nothing until something reads from it. */
	credentials?: () => Promise<S3Credentials>;
	/** A deadline for each request; validation sets one, data transfers do not. */
	timeoutMs?: number;
};

export class S3Bucket {
	constructor(
		readonly config: S3Location & Partial<S3Credentials>,
		private readonly options: S3BucketOptions = {},
	) {}

	get origin(): string {
		return storeOrigin(this.config);
	}

	private async credentials() {
		const { accessKeyId, secretAccessKey } = this.options.credentials ? await this.options.credentials() : this.config;
		if (!accessKeyId || !secretAccessKey) throw new Error("The store has no credentials");
		return { accessKeyId, secretAccessKey, region: this.config.region };
	}

	private async request(key: string | null, init: RequestInit = {}): Promise<Response> {
		return awsRequest({
			config: await this.credentials(),
			service: "s3",
			host: bucketHost(this.config),
			scheme: this.config.scheme,
			path: key === null ? bucketPath(this.config) : objectPath(this.config, key),
			fetch: this.options.fetch,
			timeoutMs: this.options.timeoutMs,
			...init,
		});
	}

	async get(key: string, options?: GetOptions): Promise<S3Object | null> {
		const range =
			options?.range instanceof Headers ? options.range.get("range") : rangeHeader(options?.range as RangeRequest);
		try {
			return new S3Object(key, await this.request(key, { headers: range ? { Range: range } : {} }));
		} catch (error) {
			if (isMissing(error)) return null;
			throw error;
		}
	}

	async head(key: string): Promise<S3Object | null> {
		const response = await this.request(key, { method: "HEAD", allowStatuses: [404] });
		return response.status === 404 ? null : new S3Object(key, response);
	}

	async put(key: string, value: PutValue, options?: S3PutOptions): Promise<S3Object> {
		const { body, length } = await prepareBody(value, options?.contentLength);
		const headers = metadataHeaders(options?.httpMetadata, options?.customMetadata);
		if (options?.storageClass) headers["x-amz-storage-class"] = options.storageClass;
		const response = await this.request(key, {
			method: "PUT",
			body,
			contentLength: length,
			unsignedPayload: true,
			headers,
		});
		const http = { ...headers, etag: response.headers.get("etag") ?? "", "content-length": String(length) };
		return new S3Object(key, new Response(null, { headers: http }), length);
	}

	/** Deletes up to 10 keys at a time in parallel, as upstream does; a key that is already gone is fine. */
	async delete(keys: string | string[]): Promise<void> {
		const list = Array.isArray(keys) ? keys : [keys];
		for (let index = 0; index < list.length; index += 10) {
			await Promise.all(
				list.slice(index, index + 10).map(async (key) => {
					try {
						await this.request(key, { method: "DELETE" });
					} catch (error) {
						if (!isMissing(error)) throw error;
					}
				}),
			);
		}
	}

	/** ListObjectsV2 in R2's shape; `cursor` is the continuation token. */
	async list(options?: { prefix?: string; cursor?: string; limit?: number; startAfter?: string }) {
		const query: Record<string, string> = { "list-type": "2" };
		if (options?.prefix) query.prefix = options.prefix;
		if (options?.cursor) query["continuation-token"] = options.cursor;
		if (options?.startAfter) query["start-after"] = options.startAfter;
		query["max-keys"] = String(Math.min(Math.max(options?.limit ?? 1000, 1), 1000));
		const parsed = parseListObjects(await (await this.request(null, { query })).text());
		return {
			objects: parsed.objects.map((object) => ({
				...object,
				httpEtag: `"${object.etag}"`,
				version: object.etag,
				httpMetadata: {},
				customMetadata: {},
				checksums: {},
				storageClass: "STANDARD",
			})),
			truncated: parsed.truncated,
			cursor: parsed.cursor,
			delimitedPrefixes: [] as string[],
		};
	}

	/** CopyObject within this bucket. */
	async copy(sourceKey: string, targetKey: string): Promise<void> {
		const response = await this.request(targetKey, {
			method: "PUT",
			headers: { "x-amz-copy-source": objectPath({ ...this.config, addressing: "path" }, sourceKey) },
		});
		const failed = errorInBody(await response.text());
		if (failed) throw new AwsError(failed.message, 200, failed.code);
	}

	async createMultipartUpload(key: string, options?: Pick<S3PutOptions, "httpMetadata" | "customMetadata">) {
		const response = await this.request(key, {
			method: "POST",
			query: { uploads: "" },
			headers: metadataHeaders(options?.httpMetadata, options?.customMetadata),
		});
		const uploadId = xmlTag(await response.text(), "UploadId");
		if (!uploadId) throw new Error("The store did not return an upload id");
		return this.resumeMultipartUpload(key, uploadId);
	}

	resumeMultipartUpload(key: string, uploadId: string) {
		return {
			key,
			uploadId,
			uploadPart: async (partNumber: number, value: PutValue, options?: { contentLength?: number }) => {
				if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000)
					throw new Error("Invalid part number");
				const { body, length } = await prepareBody(value, options?.contentLength);
				const response = await this.request(key, {
					method: "PUT",
					query: { partNumber: String(partNumber), uploadId },
					body,
					contentLength: length,
					unsignedPayload: true,
				});
				return { partNumber, etag: stripQuotes(response.headers.get("etag")) };
			},
			abort: async () => {
				try {
					await this.request(key, { method: "DELETE", query: { uploadId } });
				} catch (error) {
					if (!(error instanceof AwsError && (error.status === 404 || error.code === "NoSuchUpload"))) throw error;
				}
			},
			complete: async (parts: { partNumber: number; etag: string }[]) => {
				const response = await this.request(key, {
					method: "POST",
					query: { uploadId },
					body: completeMultipartXml(parts),
					headers: { "Content-Type": "application/xml" },
				});
				const failed = errorInBody(await response.text());
				if (failed) throw new AwsError(failed.message, 200, failed.code);
				const head = await this.head(key);
				if (!head) throw new Error("The uploaded object was not found");
				return head;
			},
		};
	}

	/** The parts the store holds for an upload, for diagnostics. */
	async listParts(key: string, uploadId: string) {
		const response = await this.request(key, { query: { uploadId } });
		return parseListParts(await response.text());
	}

	/** HeadBucket: true when the bucket exists and the key may use it. */
	async headBucket(): Promise<void> {
		await this.request(null, { method: "HEAD" });
	}

	async putCors(origins: string[]): Promise<void> {
		const body = corsRuleXml(origins);
		await this.request(null, { method: "PUT", query: { cors: "" }, body, headers: await sha256ChecksumHeaders(body) });
	}

	/** The bucket's lifecycle document, or null when it has none. */
	async getLifecycle(): Promise<string | null> {
		const response = await this.request(null, { query: { lifecycle: "" }, allowStatuses: [404] });
		return response.status === 404 ? null : response.text();
	}

	/** The URL of an object, for a browser-style request the validation sends itself (CORS preflight). */
	objectUrl(key: string): string {
		return `${this.origin}${objectPath(this.config, key)}`;
	}

	async putAbortIncompleteUploadsLifecycle(days: number): Promise<void> {
		const body = abortIncompleteLifecycleXml(days);
		await this.request(null, {
			method: "PUT",
			query: { lifecycle: "" },
			body,
			headers: await sha256ChecksumHeaders(body),
		});
	}

	private async presign(
		method: string,
		key: string,
		expiresIn: number,
		query: Record<string, string>,
		headers = {},
	): Promise<string> {
		if (!Number.isInteger(expiresIn) || expiresIn < 1 || expiresIn > MAX_PRESIGN_SECONDS)
			throw new Error("Presigned URLs expire within an hour");
		const url = new URL(this.objectUrl(key));
		for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
		return presignAwsUrl({
			method,
			url,
			region: this.config.region,
			service: "s3",
			credentials: await this.credentials(),
			expiresIn,
			headers,
		});
	}

	/** Signs browser URLs. `content-length` is a signed header on uploads, so the size cannot change. */
	get signer(): StoreSigner {
		return {
			origin: this.origin,
			presignGet: (key: string, options: PresignGetOptions) =>
				this.presign("GET", key, options.expiresIn, {
					"response-content-disposition": getContentDisposition(options.filename, options.disposition === "inline"),
					"response-content-type": options.contentType,
				}),
			presignPut: (key, options) =>
				this.presign("PUT", key, options.expiresIn, {}, { "content-length": String(options.contentLength) }),
			presignUploadPart: (key, uploadId, partNumber, options) =>
				this.presign(
					"PUT",
					key,
					options.expiresIn,
					{ partNumber: String(partNumber), uploadId },
					{ "content-length": String(options.contentLength) },
				),
		};
	}
}
