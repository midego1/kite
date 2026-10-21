import { createHash, createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * An in-process S3 for tests: a `node:http` server (and a `handle(Request)` entry for virtual-host requests
 * that cannot be resolved locally) that verifies SigV4 header and query-string signatures with a known secret.
 * It speaks enough of the API for the storage adapter, validation and the migration job: buckets by virtual
 * host or path, Get with Range, Head, Put (Content-Length required, as S3 refuses plain chunked uploads),
 * Delete, ListObjectsV2, CopyObject, multipart (create, part, complete, abort, list parts), bucket CORS and
 * lifecycle, CORS preflight and CORS headers on actual responses. Errors are the recorded documents in
 * tests/fixtures/s3. Never point it at, or copy it from, a real provider.
 */

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "s3");
const fixture = (name, values = {}) =>
	readFileSync(join(fixtures, `${name}.xml`), "utf8").replace(/\{\{(\w+)\}\}/g, (_, key) => values[key] ?? "");

const md5 = (data) => createHash("md5").update(data).digest("hex");
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const hmac = (key, data) => createHmac("sha256", key).update(data).digest();
const rfc3986 = (value) =>
	encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
const escapeXml = (value) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const tags = (xml, name) =>
	[...xml.matchAll(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "g"))].map((match) => match[1].trim());

function rawQuery(url) {
	return url.search
		.slice(1)
		.split("&")
		.filter(Boolean)
		.map((pair) => {
			const index = pair.indexOf("=");
			const name = index < 0 ? pair : pair.slice(0, index);
			const value = index < 0 ? "" : pair.slice(index + 1);
			return [decodeURIComponent(name), decodeURIComponent(value)];
		});
}

function canonicalQuery(pairs) {
	return pairs
		.map(([name, value]) => [rfc3986(name), rfc3986(value)])
		.sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
		.map(([name, value]) => `${name}=${value}`)
		.join("&");
}

function signingKey(secret, date, region) {
	return hmac(hmac(hmac(hmac(`AWS4${secret}`, date), region), "s3"), "aws4_request");
}

function xmlResponse(status, body, headers = {}) {
	return new Response(body, { status, headers: { "Content-Type": "application/xml", ...headers } });
}

export async function startFakeS3(options = {}) {
	const accessKeyId = options.accessKeyId ?? "AKIAFAKEKITE0001";
	const secretAccessKey = options.secretAccessKey ?? "fake-secret-for-kite-tests-only";
	const region = options.region ?? "us-east-1";
	const hostname = options.hostname ?? "localhost";
	const buckets = new Map();
	for (const name of options.buckets ?? ["kite-test"])
		buckets.set(name, { objects: new Map(), uploads: new Map(), cors: null, lifecycle: null });
	const state = {
		requests: [],
		/** Action names answered with AccessDenied, for example "DeleteObject" or "PutBucketCors". */
		denied: new Set(),
		/** "error200": the next CompleteMultipartUpload answers 200 with an <Error> document. */
		failNextComplete: null,
		clockOffsetMs: 0,
	};

	const errorFor = (name, status, values) => xmlResponse(status, fixture(name, values));

	function verify(request, url, body) {
		const query = rawQuery(url);
		const auth = request.headers.get("authorization");
		const params = Object.fromEntries(query);
		let credential;
		let signedHeaders;
		let provided;
		let amzDate;
		let payloadHash;
		let canonicalQueryPairs = query;
		if (auth) {
			const match = /^AWS4-HMAC-SHA256 Credential=([^,]+), SignedHeaders=([^,]+), Signature=([0-9a-f]+)$/.exec(auth);
			if (!match) return errorFor("AccessDenied", 403);
			[, credential, signedHeaders, provided] = match;
			amzDate = request.headers.get("x-amz-date") ?? "";
			payloadHash = request.headers.get("x-amz-content-sha256") ?? "";
			if (payloadHash !== "UNSIGNED-PAYLOAD" && payloadHash !== sha256(body))
				return xmlResponse(400, "<Error><Code>XAmzContentSHA256Mismatch</Code><Message>mismatch</Message></Error>");
		} else if (params["X-Amz-Signature"]) {
			credential = params["X-Amz-Credential"];
			signedHeaders = params["X-Amz-SignedHeaders"];
			provided = params["X-Amz-Signature"];
			amzDate = params["X-Amz-Date"];
			payloadHash = "UNSIGNED-PAYLOAD";
			canonicalQueryPairs = query.filter(([name]) => name !== "X-Amz-Signature");
			const issued = Date.parse(
				`${amzDate.slice(0, 4)}-${amzDate.slice(4, 6)}-${amzDate.slice(6, 8)}T${amzDate.slice(9, 11)}:${amzDate.slice(11, 13)}:${amzDate.slice(13, 15)}Z`,
			);
			if (issued + Number(params["X-Amz-Expires"]) * 1000 < Date.now() + state.clockOffsetMs)
				return xmlResponse(403, "<Error><Code>AccessDenied</Code><Message>Request has expired</Message></Error>");
		} else return errorFor("AccessDenied", 403);
		const [keyId, date, signingRegion] = credential.split("/");
		if (keyId !== accessKeyId)
			return xmlResponse(403, "<Error><Code>InvalidAccessKeyId</Code><Message>Unknown key</Message></Error>");
		const canonicalHeaders = signedHeaders
			.split(";")
			.map(
				(name) =>
					`${name}:${(name === "host" ? url.host : (request.headers.get(name) ?? "")).trim().replace(/\s+/g, " ")}\n`,
			)
			.join("");
		const canonical = [
			request.method,
			url.pathname,
			canonicalQuery(canonicalQueryPairs),
			canonicalHeaders,
			signedHeaders,
			payloadHash,
		].join("\n");
		const scope = `${date}/${signingRegion}/s3/aws4_request`;
		const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
		const expected = createHmac("sha256", signingKey(secretAccessKey, date, signingRegion))
			.update(stringToSign)
			.digest("hex");
		if (expected !== provided) return errorFor("SignatureDoesNotMatch", 403, { accessKeyId: keyId });
		return null;
	}

	function locate(url) {
		const host = url.hostname;
		for (const name of buckets.keys()) {
			if (host === `${name}.${hostname}` || host.startsWith(`${name}.`)) {
				return { bucketName: name, key: url.pathname.slice(1).split("/").map(decodeURIComponent).join("/") };
			}
		}
		const [, bucketName = "", ...rest] = url.pathname.split("/");
		return { bucketName: decodeURIComponent(bucketName), key: rest.map(decodeURIComponent).join("/") };
	}

	function corsRule(bucket, origin, method, requestedHeaders = []) {
		if (!bucket?.cors || !origin) return null;
		return (
			bucket.cors.find(
				(rule) =>
					(rule.origins.includes("*") || rule.origins.includes(origin)) &&
					rule.methods.includes(method) &&
					requestedHeaders.every((header) => rule.headers.includes("*") || rule.headers.includes(header.toLowerCase())),
			) ?? null
		);
	}

	function withCors(response, bucket, request) {
		const origin = request.headers.get("origin");
		const rule = corsRule(bucket, origin, request.method);
		if (!rule) return response;
		const headers = new Headers(response.headers);
		headers.set("Access-Control-Allow-Origin", origin);
		if (rule.expose.length) headers.set("Access-Control-Expose-Headers", rule.expose.join(", "));
		headers.set("Vary", "Origin");
		return new Response(response.body, { status: response.status, headers });
	}

	function objectHeaders(object) {
		const headers = {
			ETag: `"${object.etag}"`,
			"Last-Modified": object.lastModified.toUTCString(),
			"Content-Type": object.meta.contentType ?? "binary/octet-stream",
			"Accept-Ranges": "bytes",
		};
		if (object.meta.contentDisposition) headers["Content-Disposition"] = object.meta.contentDisposition;
		if (object.meta.cacheControl) headers["Cache-Control"] = object.meta.cacheControl;
		for (const [name, value] of Object.entries(object.meta.custom)) headers[`x-amz-meta-${name}`] = value;
		return headers;
	}

	function readMeta(request) {
		const custom = {};
		request.headers.forEach((value, name) => {
			if (name.startsWith("x-amz-meta-")) custom[name.slice("x-amz-meta-".length)] = value;
		});
		return {
			contentType: request.headers.get("content-type") ?? undefined,
			contentDisposition: request.headers.get("content-disposition") ?? undefined,
			cacheControl: request.headers.get("cache-control") ?? undefined,
			custom,
		};
	}

	function store(bucket, key, bytes, meta, etag = md5(bytes)) {
		bucket.objects.set(key, { bytes, meta, etag, lastModified: new Date() });
		return etag;
	}

	function listObjects(bucket, params) {
		const prefix = params.prefix ?? "";
		const after = params["continuation-token"] ? Buffer.from(params["continuation-token"], "base64url").toString() : "";
		const limit = Number(params["max-keys"] ?? 1000);
		const keys = [...bucket.objects.keys()].filter((key) => key.startsWith(prefix) && key > after).sort();
		const page = keys.slice(0, limit);
		const truncated = keys.length > limit;
		const contents = page
			.map((key) => {
				const object = bucket.objects.get(key);
				return `<Contents><Key>${escapeXml(key)}</Key><LastModified>${object.lastModified.toISOString()}</LastModified><ETag>"${object.etag}"</ETag><Size>${object.bytes.length}</Size><StorageClass>STANDARD</StorageClass></Contents>`;
			})
			.join("");
		const token = truncated
			? `<NextContinuationToken>${Buffer.from(page.at(-1)).toString("base64url")}</NextContinuationToken>`
			: "";
		return xmlResponse(
			200,
			`<ListBucketResult><Name>bucket</Name><Prefix>${escapeXml(prefix)}</Prefix><KeyCount>${page.length}</KeyCount><MaxKeys>${limit}</MaxKeys><IsTruncated>${truncated}</IsTruncated>${contents}${token}</ListBucketResult>`,
		);
	}

	function getObject(bucket, key, request, params, head) {
		const object = bucket.objects.get(key);
		if (!object)
			return head ? new Response(null, { status: 404 }) : errorFor("NoSuchKey", 404, { key: escapeXml(key) });
		const headers = objectHeaders(object);
		if (params["response-content-type"]) headers["Content-Type"] = params["response-content-type"];
		if (params["response-content-disposition"]) headers["Content-Disposition"] = params["response-content-disposition"];
		const size = object.bytes.length;
		const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("range") ?? "");
		if (range && !head) {
			let start;
			let end;
			if (range[1] === "") {
				start = Math.max(size - Number(range[2]), 0);
				end = size - 1;
			} else {
				start = Number(range[1]);
				end = range[2] === "" ? size - 1 : Math.min(Number(range[2]), size - 1);
			}
			if (start >= size || start > end)
				return xmlResponse(416, "<Error><Code>InvalidRange</Code><Message>bad range</Message></Error>");
			return new Response(object.bytes.subarray(start, end + 1), {
				status: 206,
				headers: {
					...headers,
					"Content-Range": `bytes ${start}-${end}/${size}`,
					"Content-Length": String(end - start + 1),
				},
			});
		}
		return new Response(head ? null : object.bytes, { headers: { ...headers, "Content-Length": String(size) } });
	}

	function completeUpload(bucket, key, params, body) {
		const upload = bucket.uploads.get(params.uploadId);
		if (!upload || upload.key !== key)
			return xmlResponse(404, "<Error><Code>NoSuchUpload</Code><Message>no upload</Message></Error>");
		const parts = tags(body.toString("utf8"), "Part").map((part) => ({
			partNumber: Number(tags(part, "PartNumber")[0]),
			etag: (tags(part, "ETag")[0] ?? "").replace(/&quot;|"/g, ""),
		}));
		for (const part of parts) {
			const stored = upload.parts.get(part.partNumber);
			if (!stored || stored.etag !== part.etag)
				return errorFor("InvalidPart", 400, { uploadId: params.uploadId, partNumber: String(part.partNumber) });
		}
		if (state.failNextComplete === "error200") {
			state.failNextComplete = null;
			return xmlResponse(200, fixture("complete-200-error"));
		}
		const bytes = Buffer.concat(parts.map((part) => upload.parts.get(part.partNumber).bytes));
		const digest = md5(Buffer.concat(parts.map((part) => Buffer.from(upload.parts.get(part.partNumber).etag, "hex"))));
		const etag = store(bucket, key, bytes, upload.meta, `${digest}-${parts.length}`);
		bucket.uploads.delete(params.uploadId);
		return xmlResponse(
			200,
			`<CompleteMultipartUploadResult><Key>${escapeXml(key)}</Key><ETag>"${etag}"</ETag></CompleteMultipartUploadResult>`,
		);
	}

	function parseCors(xml) {
		return tags(xml, "CORSRule").map((rule) => ({
			origins: tags(rule, "AllowedOrigin"),
			methods: tags(rule, "AllowedMethod"),
			headers: tags(rule, "AllowedHeader").map((header) => header.toLowerCase()),
			expose: tags(rule, "ExposeHeader"),
		}));
	}

	function action(method, key, params, request) {
		if (!key) {
			if (method === "HEAD") return "HeadBucket";
			if ("cors" in params) return method === "PUT" ? "PutBucketCors" : "GetBucketCors";
			if ("lifecycle" in params) return method === "PUT" ? "PutLifecycleConfiguration" : "GetLifecycleConfiguration";
			return "ListBucket";
		}
		if (method === "GET") return "uploadId" in params ? "ListMultipartUploadParts" : "GetObject";
		if (method === "HEAD") return "GetObject";
		if (method === "PUT") {
			if ("partNumber" in params) return "UploadPart";
			return request.headers.get("x-amz-copy-source") ? "CopyObject" : "PutObject";
		}
		if (method === "POST") return "uploads" in params ? "CreateMultipartUpload" : "CompleteMultipartUpload";
		if (method === "DELETE") return "uploadId" in params ? "AbortMultipartUpload" : "DeleteObject";
		return "Unknown";
	}

	async function route(request) {
		const url = new URL(request.url);
		const body = Buffer.from(await request.arrayBuffer());
		const params = Object.fromEntries(rawQuery(url));
		const { bucketName, key } = locate(url);
		const bucket = buckets.get(bucketName);
		state.requests.push({
			method: request.method,
			host: url.host,
			path: url.pathname,
			query: params,
			headers: Object.fromEntries(request.headers),
		});

		if (request.method === "OPTIONS") {
			const origin = request.headers.get("origin");
			const method = request.headers.get("access-control-request-method") ?? "";
			const requested = (request.headers.get("access-control-request-headers") ?? "")
				.split(",")
				.map((header) => header.trim())
				.filter(Boolean);
			const rule = corsRule(bucket, origin, method, requested);
			if (!rule)
				return xmlResponse(
					403,
					"<Error><Code>AccessForbidden</Code><Message>CORSResponse: This CORS request is not allowed.</Message></Error>",
				);
			return new Response(null, {
				status: 200,
				headers: {
					"Access-Control-Allow-Origin": origin,
					"Access-Control-Allow-Methods": rule.methods.join(", "),
					"Access-Control-Allow-Headers": requested.join(", "),
					"Access-Control-Max-Age": "3600",
					Vary: "Origin",
				},
			});
		}

		const rejected = verify(request, url, body);
		if (rejected) return rejected;
		if (!bucket)
			return xmlResponse(
				404,
				"<Error><Code>NoSuchBucket</Code><Message>The specified bucket does not exist</Message></Error>",
			);
		const name = action(request.method, key, params, request);
		if (state.denied.has(name)) return errorFor("AccessDenied", 403);

		switch (name) {
			case "HeadBucket":
				return new Response(null, { status: 200 });
			case "ListBucket":
				return listObjects(bucket, params);
			case "GetBucketCors":
				return bucket.cors
					? xmlResponse(200, "<CORSConfiguration/>")
					: xmlResponse(404, "<Error><Code>NoSuchCORSConfiguration</Code><Message>none</Message></Error>");
			case "PutBucketCors":
				bucket.cors = parseCors(body.toString("utf8"));
				return new Response(null, { status: 200 });
			case "GetLifecycleConfiguration":
				return bucket.lifecycle
					? xmlResponse(200, bucket.lifecycle)
					: xmlResponse(404, "<Error><Code>NoSuchLifecycleConfiguration</Code><Message>none</Message></Error>");
			case "PutLifecycleConfiguration":
				bucket.lifecycle = body.toString("utf8");
				return new Response(null, { status: 200 });
			case "GetObject":
				return getObject(bucket, key, request, params, request.method === "HEAD");
			case "ListMultipartUploadParts": {
				const upload = bucket.uploads.get(params.uploadId);
				if (!upload) return xmlResponse(404, "<Error><Code>NoSuchUpload</Code><Message>no upload</Message></Error>");
				const parts = [...upload.parts]
					.sort(([a], [b]) => a - b)
					.map(
						([number, part]) =>
							`<Part><PartNumber>${number}</PartNumber><ETag>"${part.etag}"</ETag><Size>${part.bytes.length}</Size></Part>`,
					)
					.join("");
				return xmlResponse(200, `<ListPartsResult><UploadId>${params.uploadId}</UploadId>${parts}</ListPartsResult>`);
			}
			case "UploadPart": {
				const upload = bucket.uploads.get(params.uploadId);
				if (!upload || upload.key !== key)
					return xmlResponse(404, "<Error><Code>NoSuchUpload</Code><Message>no upload</Message></Error>");
				const etag = md5(body);
				upload.parts.set(Number(params.partNumber), { bytes: body, etag });
				return new Response(null, { status: 200, headers: { ETag: `"${etag}"` } });
			}
			case "CopyObject": {
				const source = decodeURIComponent(request.headers.get("x-amz-copy-source") ?? "").replace(/^\//, "");
				const [sourceBucket, ...sourceKey] = source.split("/");
				const object = buckets.get(sourceBucket)?.objects.get(sourceKey.join("/"));
				if (!object) return errorFor("NoSuchKey", 404, { key: escapeXml(source) });
				const etag = store(bucket, key, object.bytes, object.meta);
				return xmlResponse(200, `<CopyObjectResult><ETag>"${etag}"</ETag></CopyObjectResult>`);
			}
			case "PutObject": {
				const etag = store(bucket, key, body, readMeta(request));
				return new Response(null, { status: 200, headers: { ETag: `"${etag}"` } });
			}
			case "CreateMultipartUpload": {
				const uploadId = randomUUID().replace(/-/g, "");
				bucket.uploads.set(uploadId, { key, parts: new Map(), meta: readMeta(request) });
				return xmlResponse(
					200,
					`<InitiateMultipartUploadResult><Bucket>${bucketName}</Bucket><Key>${escapeXml(key)}</Key><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`,
				);
			}
			case "CompleteMultipartUpload":
				return completeUpload(bucket, key, params, body);
			case "AbortMultipartUpload":
				if (!bucket.uploads.delete(params.uploadId))
					return xmlResponse(404, "<Error><Code>NoSuchUpload</Code><Message>no upload</Message></Error>");
				return new Response(null, { status: 204 });
			case "DeleteObject":
				bucket.objects.delete(key);
				return new Response(null, { status: 204 });
			default:
				return xmlResponse(501, "<Error><Code>NotImplemented</Code><Message>not implemented</Message></Error>");
		}
	}

	async function handle(request) {
		const url = new URL(request.url);
		const bucket = buckets.get(locate(url).bucketName);
		return withCors(await route(request), bucket, request);
	}

	const listener = async (incoming, outgoing) => {
		try {
			if (
				(incoming.method === "PUT" || incoming.method === "POST") &&
				incoming.headers["content-length"] === undefined
			) {
				incoming.resume();
				outgoing.writeHead(411, { "Content-Type": "application/xml" });
				outgoing.end(
					"<Error><Code>MissingContentLength</Code><Message>You must provide the Content-Length HTTP header.</Message></Error>",
				);
				return;
			}
			const chunks = [];
			for await (const chunk of incoming) chunks.push(chunk);
			const headers = new Headers();
			for (const [name, value] of Object.entries(incoming.headers)) {
				if (name === "host" || value === undefined) continue;
				headers.set(name, Array.isArray(value) ? value.join(", ") : value);
			}
			const method = incoming.method ?? "GET";
			const request = new Request(`http://${incoming.headers.host}${incoming.url}`, {
				method,
				headers,
				body: method === "GET" || method === "HEAD" ? undefined : Buffer.concat(chunks),
			});
			const response = await handle(request);
			const responseHeaders = Object.fromEntries(response.headers);
			outgoing.writeHead(response.status, responseHeaders);
			outgoing.end(method === "HEAD" ? undefined : Buffer.from(await response.arrayBuffer()));
		} catch (error) {
			outgoing.writeHead(500);
			outgoing.end(String(error));
		}
	};
	const server = createServer(listener);
	await new Promise((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
	const { port } = server.address();
	// `localhost` may resolve to ::1 first; answer there too so every client finds the same store.
	const ipv6 = createServer(listener);
	if (hostname === "localhost")
		await new Promise((resolve) => {
			ipv6.once("error", resolve);
			ipv6.listen(port, "::1", resolve);
		});
	return {
		accessKeyId,
		secretAccessKey,
		region,
		port,
		endpoint: `${hostname}:${port}`,
		url: `http://${hostname}:${port}`,
		buckets,
		state,
		handle,
		/** Bytes of a stored object, or null. */
		object: (bucket, key) => buckets.get(bucket)?.objects.get(key) ?? null,
		close: async () => {
			for (const instance of [server, ipv6]) {
				if (!instance.listening) continue;
				instance.closeAllConnections();
				await new Promise((resolve) => instance.close(() => resolve()));
			}
		},
	};
}
