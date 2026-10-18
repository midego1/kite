import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { makeBundleDirectory } from "./support/bundle-directory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = makeBundleDirectory("kite-remote-images-fetch-");
after(() => rmSync(directory, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export * from "./src/lib/remote-images/fetch-utils.ts";
			export * from "./src/lib/remote-images/message-urls-utils.ts";
			export * from "./src/lib/remote-images/proxy-url-utils.ts";
		`,
		resolveDir: root,
		sourcefile: "remote-images-fetch-entry.ts",
	},
	outfile: join(directory, "entry.mjs"),
	bundle: true,
	sourcemap: "inline",
	absWorkingDir: root,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	logLevel: "silent",
});
const images = await import(pathToFileURL(join(directory, "entry.mjs")).href);
const { fetchRemoteImage, parseRemoteImageUrl, RemoteImageError } = images;

const APP = "https://mail.kite.example.com";
const policy = { appOrigin: APP };
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const GIF = new TextEncoder().encode("GIF89a\x01\x00\x01\x00");
const WEBP = new TextEncoder().encode("RIFF\x00\x00\x00\x00WEBPVP8 ");
const AVIF = Uint8Array.from([
	0,
	0,
	0,
	0x1c,
	...new TextEncoder().encode("ftypmif1\x00\x00\x00\x00mif1avif"),
	0,
	0,
	0,
	0,
]);
const image = (body, type = "image/png", headers = {}) =>
	new Response(body, { headers: { "Content-Type": type, ...headers } });
const fails = (code, status) => (error) =>
	error instanceof RemoteImageError && error.code === code && (status === undefined || error.status === status);

test("only public https and http hosts on the default port are accepted, and http is upgraded", () => {
	assert.equal(
		parseRemoteImageUrl("https://images.example.com/a.png", policy).href,
		"https://images.example.com/a.png",
	);
	assert.equal(parseRemoteImageUrl("http://images.example.com/a.png", policy).href, "https://images.example.com/a.png");
	assert.equal(parseRemoteImageUrl("https://images.example.com:443/a.png", policy).port, "");
});

test("private, loopback, link-local, metadata, local and reserved destinations are refused before any fetch", () => {
	for (const value of [
		"",
		"not a url",
		"file:///etc/passwd",
		"data:image/png;base64,AAAA",
		"ftp://images.example.com/a.png",
		"javascript:alert(1)",
		"https://user:secret@images.example.com/a.png",
		"https://:secret@images.example.com/a.png",
		"https://images.example.com:8443/a.png",
		"http://images.example.com:443/a.png",
		"http://127.0.0.1/a.png",
		"http://127.1/a.png",
		"http://0x7f.0.0.1/a.png",
		"http://2130706433/a.png",
		"http://10.0.0.5/a.png",
		"http://172.16.0.1/a.png",
		"http://192.168.1.1/a.png",
		"http://169.254.169.254/latest/meta-data/",
		"http://100.64.0.1/a.png",
		"http://0.0.0.0/a.png",
		"http://[::1]/a.png",
		"http://[::ffff:127.0.0.1]/a.png",
		"http://[fd00::1]/a.png",
		"http://[fe80::1]/a.png",
		"https://8.8.8.8/a.png",
		"https://[2606:4700::1111]/a.png",
		"http://localhost/a.png",
		"http://app.localhost/a.png",
		"http://metadata/computeMetadata/v1/",
		"http://metadata.google.internal/computeMetadata/v1/",
		"http://service.internal/a.png",
		"http://printer.local/a.png",
		"http://router.home.arpa/a.png",
		"http://1.0.0.127.in-addr.arpa/a.png",
		"http://intranet/a.png",
		"https://images.e2e.test/a.png",
		"https://cdn.example/a.png",
		"https://bad.invalid/a.png",
		"https://hidden.onion/a.png",
		`${APP}/api/remote-images?url=x`,
		"http://mail.kite.example.com/a.png",
		`https://images.example.com/${"a".repeat(4096)}`,
	]) {
		assert.throws(() => parseRemoteImageUrl(value, policy), fails("invalid_url", 400), value);
	}
});

test("the dev loopback allowance admits only http(s) on 127.0.0.1 and never the app's own port", () => {
	assert.equal(images.isRemoteImageLoopbackAllowed("1", "development"), true);
	assert.equal(images.isRemoteImageLoopbackAllowed("1", undefined), true);
	assert.equal(images.isRemoteImageLoopbackAllowed("1", "production"), false);
	assert.equal(images.isRemoteImageLoopbackAllowed("true", "development"), false);
	assert.equal(images.isRemoteImageLoopbackAllowed(undefined, "development"), false);

	const loopback = { appOrigin: "http://localhost:3310", allowLoopback: true };
	assert.equal(parseRemoteImageUrl("http://127.0.0.1:4567/a.png", loopback).href, "http://127.0.0.1:4567/a.png");
	for (const value of [
		"http://127.0.0.1:3310/api/messages",
		"http://localhost:4567/a.png",
		"http://127.0.0.2:4567/a.png",
		"http://10.0.0.1/a.png",
		"http://[::1]:4567/a.png",
		"http://user:pw@127.0.0.1:4567/a.png",
	]) {
		assert.throws(() => parseRemoteImageUrl(value, loopback), fails("invalid_url"), value);
	}
	assert.throws(() => parseRemoteImageUrl("http://127.0.0.1:4567/a.png", policy), fails("invalid_url"));
});

test("a valid image is returned without any upstream header, and the request carries only Accept and User-Agent", async () => {
	const calls = [];
	const result = await fetchRemoteImage("http://images.example.com/photo.png", {
		...policy,
		fetch: async (url, init) => {
			calls.push({ url, init });
			return image(PNG, "image/png; charset=binary", {
				"Cross-Origin-Resource-Policy": "same-origin",
				"Set-Cookie": "tracker=1",
			});
		},
	});
	assert.equal(result.contentType, "image/png");
	assert.deepEqual([...result.body], [...PNG]);
	assert.deepEqual(Object.keys(result).sort(), ["body", "contentType"]);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, "https://images.example.com/photo.png");
	assert.equal(calls[0].init.redirect, "manual");
	assert.equal(calls[0].init.method, "GET");
	const headers = new Headers(calls[0].init.headers);
	assert.deepEqual([...headers.keys()].sort(), ["accept", "user-agent"]);
	assert.match(headers.get("accept"), /^image\//);
	assert.ok(!("credentials" in calls[0].init) && !("referrer" in calls[0].init));
});

test("every supported raster format passes its signature check", async () => {
	for (const [type, body] of [
		["image/png", PNG],
		["image/jpeg", JPEG],
		["image/gif", GIF],
		["image/webp", WEBP],
		["image/avif", AVIF],
	]) {
		const result = await fetchRemoteImage("https://images.example.com/x", {
			...policy,
			fetch: async () => image(body, type),
		});
		assert.equal(result.contentType, type);
	}
});

test("SVG, HTML, missing and other non-raster types are refused with 415", async () => {
	for (const type of ["image/svg+xml", "text/html", "application/octet-stream", "image/x-icon", "text/xml", ""]) {
		await assert.rejects(
			fetchRemoteImage("https://images.example.com/x", {
				...policy,
				fetch: async () =>
					new Response("<svg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'/>", {
						headers: type ? { "Content-Type": type } : {},
					}),
			}),
			fails("unsupported_type", 415),
			type,
		);
	}
});

test("a body that does not match its declared image type is refused", async () => {
	for (const [type, body] of [
		["image/png", "<html><script>alert(1)</script></html>"],
		["image/png", "<svg xmlns='http://www.w3.org/2000/svg'/>"],
		["image/jpeg", PNG],
		["image/gif", "GIF90a"],
		["image/webp", "RIFF0000WAVE"],
		["image/avif", Uint8Array.from([0, 0, 0, 0x10, ...new TextEncoder().encode("ftypisom"), 0, 0, 0, 0])],
		["image/avif", Uint8Array.from([1, 2, 3])],
	]) {
		await assert.rejects(
			fetchRemoteImage("https://images.example.com/x", { ...policy, fetch: async () => image(body, type) }),
			fails("invalid_signature", 415),
			type,
		);
	}
});

test("every redirect is validated, so a redirect to a private or local host stops before another fetch", async () => {
	for (const location of [
		"http://127.0.0.1/private.png",
		"http://169.254.169.254/latest/meta-data/",
		"http://[::1]/a.png",
		"http://localhost/a.png",
		"https://images.example.com:8080/a.png",
		"https://user:pw@images.example.com/a.png",
		`${APP}/api/messages`,
		"file:///etc/passwd",
	]) {
		let calls = 0;
		await assert.rejects(
			fetchRemoteImage("https://images.example.com/start", {
				...policy,
				fetch: async () => {
					calls += 1;
					return new Response(null, { status: 302, headers: { Location: location } });
				},
			}),
			fails("invalid_url", 400),
			location,
		);
		assert.equal(calls, 1, location);
	}
});

test("relative redirects resolve against the current hop and are followed up to the cap", async () => {
	const seen = [];
	const result = await fetchRemoteImage("https://images.example.com/a", {
		...policy,
		fetch: async (url) => {
			seen.push(url);
			if (url.endsWith("/a")) return new Response(null, { status: 301, headers: { Location: "/b" } });
			if (url.endsWith("/b"))
				return new Response(null, { status: 307, headers: { Location: "http://cdn.example.org/c" } });
			return image(PNG);
		},
	});
	assert.equal(result.contentType, "image/png");
	assert.deepEqual(seen, ["https://images.example.com/a", "https://images.example.com/b", "https://cdn.example.org/c"]);

	let calls = 0;
	await assert.rejects(
		fetchRemoteImage("https://images.example.com/loop", {
			...policy,
			fetch: async (url) => {
				calls += 1;
				return new Response(null, { status: 302, headers: { Location: url } });
			},
		}),
		fails("too_many_redirects", 502),
	);
	assert.equal(calls, 4);

	await assert.rejects(
		fetchRemoteImage("https://images.example.com/x", {
			...policy,
			fetch: async () => new Response(null, { status: 302 }),
		}),
		fails("invalid_redirect", 502),
	);
	await assert.rejects(
		fetchRemoteImage("https://images.example.com/x", {
			...policy,
			fetch: async () => new Response(null, { status: 302, headers: { Location: "http://[bad" } }),
		}),
		fails("invalid_redirect", 502),
	);
});

test("an oversized body is refused by Content-Length or by counting the stream, which is cancelled", async () => {
	await assert.rejects(
		fetchRemoteImage("https://images.example.com/huge.png", {
			...policy,
			fetch: async () => image(PNG, "image/png", { "Content-Length": String(5 * 1024 * 1024 + 1) }),
		}),
		fails("too_large", 413),
	);
	let cancelled = false;
	const body = new ReadableStream({
		start(controller) {
			controller.enqueue(PNG);
			controller.enqueue(new Uint8Array(8));
		},
		cancel() {
			cancelled = true;
		},
	});
	await assert.rejects(
		fetchRemoteImage("https://images.example.com/large.png", {
			...policy,
			maxBytes: PNG.byteLength,
			fetch: async () => image(body),
		}),
		fails("too_large", 413),
	);
	assert.equal(cancelled, true);
});

test("upstream errors, empty bodies and network failures map to 502", async () => {
	await assert.rejects(
		fetchRemoteImage("https://images.example.com/x", {
			...policy,
			fetch: async () => new Response("no", { status: 404, headers: { "Content-Type": "image/png" } }),
		}),
		fails("upstream_status", 502),
	);
	await assert.rejects(
		fetchRemoteImage("https://images.example.com/x", {
			...policy,
			fetch: async () => new Response(null, { headers: { "Content-Type": "image/png" } }),
		}),
		fails("empty_body", 502),
	);
	await assert.rejects(
		fetchRemoteImage("https://images.example.com/x", {
			...policy,
			fetch: async () => {
				throw new TypeError("network down");
			},
		}),
		fails("upstream_error", 502),
	);
});

test("one timeout covers the request and a body that stalls after the headers", async () => {
	await assert.rejects(
		fetchRemoteImage("https://images.example.com/slow.png", {
			...policy,
			timeoutMs: 10,
			fetch: (_url, init) =>
				new Promise((_resolve, reject) => {
					init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
				}),
		}),
		fails("timeout", 504),
	);
	await assert.rejects(
		fetchRemoteImage("https://images.example.com/slow-body.png", {
			...policy,
			timeoutMs: 10,
			fetch: async (_url, init) =>
				image(
					new ReadableStream({
						start(controller) {
							init.signal.addEventListener("abort", () => controller.error(init.signal.reason), { once: true });
						},
					}),
				),
		}),
		fails("timeout", 504),
	);
});

test("the proxy only serves URLs that an <img src> in the stored message names", () => {
	const base = APP;
	const html = [
		'<p>Hi</p><IMG SRC=" https://images.example.com/logo.png?a=1&amp;b=2 " alt="logo">',
		'<img src="//cdn.example.org/pixel.gif">',
		'<a href="https://evil.example.com/link.png">link</a>',
		'<div style="background:url(https://evil.example.com/bg.png)">x</div>',
		"<p>https://evil.example.com/text.png</p>",
		'<img alt="no src">',
	].join("");
	const references = (url) => images.messageHtmlReferencesImage(html, url, base);
	assert.equal(references("https://images.example.com/logo.png?a=1&b=2"), true);
	assert.equal(references("https://cdn.example.org/pixel.gif"), true);
	for (const url of [
		"https://images.example.com/logo.png",
		"https://images.example.com/logo.png?a=1&amp;b=2",
		"https://evil.example.com/link.png",
		"https://evil.example.com/bg.png",
		"https://evil.example.com/text.png",
		"http://169.254.169.254/",
		"not a url",
		"",
	]) {
		assert.equal(references(url), false, url);
	}
	assert.equal(images.messageHtmlReferencesImage(null, "https://images.example.com/logo.png", base), false);
	assert.equal(images.messageHtmlReferencesImage("", "https://images.example.com/logo.png", base), false);
});

test("proxy URLs carry the message id and the encoded image URL", () => {
	const href = images.remoteImageProxyUrl("msg 1", "https://images.example.com/a.png?x=1&y=2");
	assert.ok(href.startsWith("/api/remote-images?"));
	const params = new URL(href, APP).searchParams;
	assert.equal(params.get("message"), "msg 1");
	assert.equal(params.get("url"), "https://images.example.com/a.png?x=1&y=2");
});
