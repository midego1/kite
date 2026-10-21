import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";
import { bundleModules } from "./support/modules-bundle.mjs";

const { signAwsRequest, presignAwsUrl, canonicalQueryString, UNSIGNED_PAYLOAD } = await bundleModules(
	"kite-storage-sigv4-",
	[["signAwsRequest, presignAwsUrl, canonicalQueryString, UNSIGNED_PAYLOAD", "src/lib/aws/sigv4.ts"]],
);

// The example credentials from AWS's S3 Signature Version 4 documentation.
const EXAMPLE = { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" };
const EXAMPLE_DATE = new Date("2013-05-24T00:00:00Z");

test("presigning matches AWS's published query-string example", async () => {
	const url = await presignAwsUrl({
		method: "GET",
		url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
		region: "us-east-1",
		service: "s3",
		credentials: EXAMPLE,
		expiresIn: 86400,
		now: EXAMPLE_DATE,
	});
	assert.equal(
		url,
		"https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
	);
});

test("header signing matches AWS's published GET Object example", async () => {
	const headers = await signAwsRequest({
		method: "GET",
		url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
		headers: { Range: "bytes=0-9" },
		body: "",
		region: "us-east-1",
		service: "s3",
		credentials: EXAMPLE,
		now: EXAMPLE_DATE,
	});
	assert.equal(
		headers.Authorization,
		"AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
	);
});

/** An independent SigV4 over node:crypto, to check canonical requests the published examples do not cover. */
function referenceSignature(canonicalRequest, amzDate, region, secret) {
	const date = amzDate.slice(0, 8);
	const scope = `${date}/${region}/s3/aws4_request`;
	const stringToSign = [
		"AWS4-HMAC-SHA256",
		amzDate,
		scope,
		createHash("sha256").update(canonicalRequest).digest("hex"),
	].join("\n");
	let key = createHmac("sha256", `AWS4${secret}`).update(date).digest();
	for (const part of [region, "s3", "aws4_request"]) key = createHmac("sha256", key).update(part).digest();
	return createHmac("sha256", key).update(stringToSign).digest("hex");
}

test("an UNSIGNED-PAYLOAD request signs the literal instead of a body hash", async () => {
	const headers = await signAwsRequest({
		method: "PUT",
		url: new URL("http://localhost:9000/bucket/drive/drv_1?partNumber=2&uploadId=abc"),
		headers: { "content-length": "5" },
		payloadHash: UNSIGNED_PAYLOAD,
		body: "ignored",
		region: "us-east-1",
		service: "s3",
		credentials: EXAMPLE,
		now: EXAMPLE_DATE,
	});
	assert.equal(headers["x-amz-content-sha256"], "UNSIGNED-PAYLOAD");
	const canonical = [
		"PUT",
		"/bucket/drive/drv_1",
		"partNumber=2&uploadId=abc",
		"content-length:5\nhost:localhost:9000\nx-amz-content-sha256:UNSIGNED-PAYLOAD\nx-amz-date:20130524T000000Z\n",
		"content-length;host;x-amz-content-sha256;x-amz-date",
		"UNSIGNED-PAYLOAD",
	].join("\n");
	const signature = referenceSignature(canonical, "20130524T000000Z", "us-east-1", EXAMPLE.secretAccessKey);
	assert.match(headers.Authorization, new RegExp(`Signature=${signature}$`));
});

test("a presigned upload part signs content-length, and the query is encoded as it is signed", async () => {
	const url = new URL(
		await presignAwsUrl({
			method: "PUT",
			url: new URL("https://bucket.s3.eu-central-1.amazonaws.com/drive/drv_1?partNumber=1&uploadId=a%2Bb"),
			region: "eu-central-1",
			service: "s3",
			credentials: { ...EXAMPLE, sessionToken: "token/with+chars" },
			expiresIn: 900,
			headers: { "content-length": "1024" },
			now: EXAMPLE_DATE,
		}),
	);
	assert.equal(url.searchParams.get("X-Amz-SignedHeaders"), "content-length;host");
	assert.equal(url.searchParams.get("X-Amz-Security-Token"), "token/with+chars");
	assert.equal(url.searchParams.get("uploadId"), "a+b");
	const pairs = [...url.searchParams].filter(([name]) => name !== "X-Amz-Signature");
	const canonical = [
		"PUT",
		"/drive/drv_1",
		canonicalQueryString(pairs),
		"content-length:1024\nhost:bucket.s3.eu-central-1.amazonaws.com\n",
		"content-length;host",
		"UNSIGNED-PAYLOAD",
	].join("\n");
	assert.equal(
		url.searchParams.get("X-Amz-Signature"),
		referenceSignature(canonical, "20130524T000000Z", "eu-central-1", EXAMPLE.secretAccessKey),
	);
	assert.ok(url.search.includes("uploadId=a%2Bb"), "a plus sign is percent-encoded, never sent as a space");
});

test("presigned URLs refuse lifetimes SigV4 does not allow", async () => {
	const input = {
		method: "GET",
		url: new URL("https://bucket.example.com/key"),
		region: "auto",
		service: "s3",
		credentials: EXAMPLE,
	};
	await assert.rejects(presignAwsUrl({ ...input, expiresIn: 0 }), /7 days/);
	await assert.rejects(presignAwsUrl({ ...input, expiresIn: 604801 }), /7 days/);
	await assert.rejects(presignAwsUrl({ ...input, expiresIn: 1.5 }), /7 days/);
});

test("canonical query strings sort by encoded name, then value", () => {
	assert.equal(
		canonicalQueryString([
			["b", "2"],
			["a", "z"],
			["a", "y"],
			["response-content-disposition", "attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf"],
		]),
		"a=y&a=z&b=2&response-content-disposition=attachment%3B%20filename%2A%3DUTF-8%27%27r%25C3%25A9sum%25C3%25A9.pdf",
	);
});
